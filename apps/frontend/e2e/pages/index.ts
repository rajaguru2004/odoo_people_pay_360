import { Page, expect } from '@playwright/test';

/**
 * Page objects, kept deliberately thin.
 *
 * They exist for one reason: to put every selector in one file, so that when a
 * screen is restyled exactly one place changes. They are not a second
 * implementation of the app — no business rules live here, and anything a spec
 * asserts stays in the spec where a reader can see it.
 *
 * Selector policy, in order of preference:
 *
 *   1. `data-testid` — seeded on the critical path. There is very little else
 *      to hold: this app has almost no `aria-label` or `htmlFor`, so
 *      `getByRole`/`getByLabel` are unreliable here.
 *   2. structural (`input[type="date"]`) where the shape is stable.
 *   3. `href` for navigation.
 *
 * Never visible text: labels come from next-intl and exist in English and
 * Arabic, so a text selector encodes the language rather than the intent.
 */

/** Shared waiting. The dashboard decides auth client-side, so a bare goto proves nothing. */
/** `data-*` attributes are strings; this is the one place that admits it. */
function num(value: string | null): number {
  return value === null || value === '' ? 0 : Number(value);
}

/**
 * Clicks the ConfirmModal's confirm button, waiting for it to actually be there.
 *
 * The modal mounts on a state change, so clicking the trigger and the confirm in
 * consecutive statements races the render: Playwright's auto-wait covers the
 * element appearing, but the modal's own open transition can still swallow the
 * first click, which shows up as an intermittent "the record did not change".
 */
async function confirmDialog(page: Page): Promise<void> {
  const confirm = page.getByTestId('confirm-modal-confirm');
  await confirm.waitFor({ state: 'visible', timeout: 10_000 });
  await confirm.click();
  await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Puts the browser in a named branch, the way the top-bar picker would.
 *
 * `branch-storage` is the zustand slice the axios interceptor reads to set
 * `X-Branch-Id` on every request, and the restored sessions in `.auth/` arrive
 * with nothing selected. Any spec whose data lives in a particular branch has to
 * say so, or the screen lists nothing — and, worse, a by-id read of a record in
 * another branch answers 404 (`assertInBranch` throws NotFound), so the failure
 * reads as "the record does not exist" rather than "the view is pointed
 * somewhere else".
 *
 * ## Why this is an init script and not a plain localStorage write
 *
 * `BranchPicker` forces a concrete selection: on mount, if nothing is selected,
 * it writes `options[0]` — and zustand then persists its in-memory value over
 * whatever localStorage holds. Writing the key after navigating therefore lost
 * the race about half the time; the store had already defaulted to the first
 * branch (the empty second one, alphabetically) and re-persisted it on the next
 * render, silently sending every request to the wrong branch.
 *
 * Registering it as an init script means the value is in place before any app
 * code runs, on this navigation and every one after it, so the picker sees a
 * selection that is already valid and leaves it alone.
 */
export async function selectBranch(page: Page, branchId: string): Promise<void> {
  const write = (id: string) => {
    window.localStorage.setItem(
      'branch-storage',
      JSON.stringify({ state: { selectedBranchId: id }, version: 0 }),
    );
  };
  await page.addInitScript(write, branchId);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.evaluate(write, branchId);
}

/**
 * Accepts native `window.confirm` / `window.alert` dialogs for this page.
 *
 * Playwright's default is to DISMISS them, which makes a `confirm`-guarded
 * button click do nothing at all and produces a test failure that looks like a
 * broken backend. The payroll detail and payroll approvals screens both still
 * use the browser's dialogs rather than the app's `ConfirmModal`.
 */
export async function acceptNativeDialogs(page: Page): Promise<void> {
  page.on('dialog', (dialog) => {
    void dialog.accept().catch(() => {});
  });
}

export class LeaveRequestPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/leaves/new');
  }

  /**
   * Fills and submits a request. `reason` must clear the ten-character minimum
   * the form enforces — passing something shorter is how you test the rule, not
   * how you use this helper.
   */
  async submit(opts: { startDate: string; endDate: string; reason: string; leaveType?: string }): Promise<void> {
    const dates = this.page.locator('input[type="date"]');
    await dates.nth(0).fill(opts.startDate);
    await dates.nth(1).fill(opts.endDate);

    if (opts.leaveType) {
      await this.page.locator('select').first().selectOption({ label: opts.leaveType });
    }

    await this.page.locator('textarea').first().fill(opts.reason);
    await this.page.getByTestId('leave-submit').click();
  }

  /** Fills without submitting — for cases that assert on the live preview. */
  async fill(opts: { startDate?: string; endDate?: string; reason?: string; leaveType?: string }): Promise<void> {
    const dates = this.page.locator('input[type="date"]');
    if (opts.startDate) await dates.nth(0).fill(opts.startDate);
    if (opts.endDate) await dates.nth(1).fill(opts.endDate);
    if (opts.leaveType) {
      await this.page.locator('select').first().selectOption({ label: opts.leaveType });
    }
    if (opts.reason) await this.page.locator('textarea').first().fill(opts.reason);
  }

  async submitOnly(): Promise<void> {
    await this.page.getByTestId('leave-submit').click();
  }

  /** Still on the form means it was refused — what a validation case wants. */
  async stillOnForm(): Promise<boolean> {
    return this.page.getByTestId('leave-submit').isVisible().catch(() => false);
  }

  /** The leave types the picker actually offers (gender filtering applies). */
  async typeOptions(): Promise<string[]> {
    return this.page
      .locator('select')
      .first()
      .locator('option')
      .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? '').filter(Boolean));
  }

  /** ADMIN and HR get a refusal panel instead of the form. */
  async isDeniedPanel(): Promise<boolean> {
    return !(await this.page.getByTestId('leave-submit').isVisible().catch(() => false));
  }

  /** Attach files through the hidden input, bypassing the OS picker. */
  async attach(paths: string[]): Promise<void> {
    await this.page.locator('input[type="file"]').setInputFiles(paths);
  }

  /** Resolves once the app has navigated away, which is its success signal. */
  async expectSubmitted(): Promise<void> {
    await this.page.waitForURL('**/my-leaves', { timeout: 20_000 });
  }
}

export class MyLeavesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-leaves');
  }

  /**
   * The id of the most recent request, read from the link the row navigates to.
   * Returned rather than clicked so the caller can hand it to another role.
   */
  async firstRequestId(): Promise<string | null> {
    const rows = this.page.locator('[data-testid="my-leave-row"]');
    if ((await rows.count()) === 0) return null;
    return rows.first().getAttribute('data-leave-id');
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('my-leave-row').count();
  }

  /**
   * The MOBILE card list, counted separately on purpose.
   *
   * This screen renders every row twice — a `hidden md:block` table and a
   * `md:hidden` card list — and Playwright's `.count()` includes hidden
   * elements. Sharing one testid would silently double every count and make the
   * stat comparisons pass for the wrong reason.
   */
  async cardCount(): Promise<number> {
    return this.page.getByTestId('my-leave-card').count();
  }

  async rowIds(): Promise<string[]> {
    return this.page
      .getByTestId('my-leave-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-leave-id') ?? ''));
  }

  async rowStatus(id: string): Promise<string | null> {
    return this.page
      .locator(`[data-testid="my-leave-row"][data-leave-id="${id}"]`)
      .getAttribute('data-leave-status');
  }

  async filter(key: 'all' | 'PENDING' | 'APPROVED' | 'REJECTED'): Promise<void> {
    await this.page.locator(`[data-testid="my-leave-filter"][data-key="${key}"]`).click();
  }

  async activeFilter(): Promise<string | null> {
    const active = this.page.locator('[data-testid="my-leave-filter"][data-active="true"]');
    if (!(await active.count())) return null;
    return active.first().getAttribute('data-key');
  }

  async stat(key: 'total' | 'pending' | 'approved' | 'rejected'): Promise<number> {
    return num(
      await this.page
        .locator(`[data-testid="my-leave-stat"][data-key="${key}"]`)
        .getAttribute('data-value'),
    );
  }

  async balance(leaveType: string): Promise<{ remaining: number; total: number } | null> {
    const card = this.page.locator(
      `[data-testid="my-leave-balance-card"][data-leave-type="${leaveType}"]`,
    );
    if (!(await card.count())) return null;
    return {
      remaining: num(await card.getAttribute('data-remaining')),
      total: num(await card.getAttribute('data-total')),
    };
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('my-leave-empty').isVisible().catch(() => false);
  }

  async openRow(id: string): Promise<void> {
    await this.page.locator(`[data-testid="my-leave-row"][data-leave-id="${id}"]`).click();
  }
}

export class LeaveDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/leaves/${id}`);
  }

  /** The machine-readable status, not the translated label. */
  async status(): Promise<string | null> {
    return this.page.getByTestId('leave-status').getAttribute('data-status');
  }

  async expectStatus(expected: string): Promise<void> {
    await expect.poll(() => this.status(), { timeout: 15_000 }).toBe(expected);
  }

  /** Two clicks by design: the screen asks for confirmation before approving. */
  async approve(): Promise<void> {
    await this.page.getByTestId('leave-approve-open').click();
    await this.page.getByTestId('leave-approve-confirm').click();
  }

  /**
   * `textarea.last()` used to pick this box. Both modals carry a textarea, so
   * that selector was one render away from filling the APPROVE comment and
   * rejecting with an empty reason. Bound to its own id now.
   */
  async reject(reason: string): Promise<void> {
    await this.page.getByTestId('leave-reject-open').click();
    await this.page.getByTestId('leave-reject-reason').fill(reason);
    await this.page.getByTestId('leave-reject-confirm').click();
  }

  /** Whether this role is offered the approval controls at all. */
  async canApprove(): Promise<boolean> {
    return this.page.getByTestId('leave-approve-open').isVisible().catch(() => false);
  }

  async canReject(): Promise<boolean> {
    return this.page.getByTestId('leave-reject-open').isVisible().catch(() => false);
  }

  async canCancel(): Promise<boolean> {
    return this.page.getByTestId('leave-cancel').isVisible().catch(() => false);
  }

  /** Routes through the shared confirm dialog. */
  async cancel(): Promise<void> {
    await this.page.getByTestId('leave-cancel').click();
    await this.page.getByTestId('confirm-modal-confirm').click();
  }

  async totalDays(): Promise<number> {
    return num(await this.page.getByTestId('leave-total-days').getAttribute('data-days'));
  }

  async balanceRemaining(leaveType: string): Promise<number | null> {
    const card = this.page.locator(
      `[data-testid="leave-balance-card"][data-leave-type="${leaveType}"]`,
    );
    if (!(await card.count())) return null;
    return num(await card.getAttribute('data-remaining'));
  }

  async hasBalanceWarning(): Promise<boolean> {
    return this.page.getByTestId('leave-balance-warning').isVisible().catch(() => false);
  }

  async attachments(): Promise<Array<{ id: string; fileName: string }>> {
    return this.page.getByTestId('leave-attachment').evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute('data-attachment-id') ?? '',
        fileName: e.getAttribute('data-file-name') ?? '',
      })),
    );
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.page
      .locator(`[data-testid="leave-attachment"][data-attachment-id="${attachmentId}"]`)
      .getByTestId('leave-attachment-delete')
      .click();
    await this.page.getByTestId('confirm-modal-confirm').click();
  }

  trail(): ApprovalTrailPanel {
    return new ApprovalTrailPanel(this.page, 'leave');
  }

  async notFound(): Promise<boolean> {
    return !(await this.page.getByTestId('leave-status').isVisible().catch(() => false));
  }
}

export class MyAttendancePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-attendance');
  }

  async canCheckIn(): Promise<boolean> {
    return this.page.getByTestId('attendance-check-in').isVisible().catch(() => false);
  }

  async canCheckOut(): Promise<boolean> {
    return this.page.getByTestId('attendance-check-out').isVisible().catch(() => false);
  }
}

export class PayrollManagePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/payroll/manage');
  }

  /**
   * Locking is the step that matters: it is the only one that settles
   * reimbursements and loan recoveries, and a LOCKED run cannot be edited.
   * Guarded by the shared confirm dialog.
   */
  async lockFirst(): Promise<void> {
    await this.page.getByTestId('payroll-lock').first().click();
    await confirmDialog(this.page);
  }

  async submitFirstForApproval(): Promise<void> {
    await this.page.getByTestId('payroll-submit-approval').first().click();
    await confirmDialog(this.page);
  }

  async hasLockableRun(): Promise<boolean> {
    return (await this.page.getByTestId('payroll-lock').count()) > 0;
  }
}

/**
 * Salary advances & loans.
 *
 * The tabs are not cosmetic: only the "All requests" tab is served by the
 * paginated endpoint, and the row-level Approve/Reject controls are rendered
 * only where `activeTab !== 'my'` — so a spec that wants to approve has to be on
 * the approver's tab, not on the requester's.
 */
export class AdvanceLoansPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/advance-loans');
  }

  /** `pending` (approver queue), `my` (own history) or `all` (admin, paginated). */
  async openTab(key: 'pending' | 'my' | 'all'): Promise<void> {
    const tab = this.page.getByTestId(`loan-tab-${key}`);
    if ((await tab.count()) === 0) return;
    await tab.click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  row(loanId: string) {
    return this.page.locator(`[data-testid="loan-row"][data-loan-id="${loanId}"]`);
  }

  /**
   * The machine-readable status on a row, never the translated badge text.
   *
   * `null` when the row is not on screen at all, rather than a ten-second
   * timeout — callers poll this while a list is still loading, and an absent row
   * is an answer.
   */
  async rowStatus(loanId: string): Promise<string | null> {
    const row = this.row(loanId);
    if ((await row.count()) === 0) return null;
    return row.getAttribute('data-loan-status');
  }

  async hasRow(loanId: string): Promise<boolean> {
    return (await this.row(loanId).count()) > 0;
  }

  /** Whether this role is offered the approval control on that row at all. */
  async canApprove(loanId: string): Promise<boolean> {
    return this.row(loanId).getByTestId('loan-approve').isVisible().catch(() => false);
  }

  /**
   * Files a request through the create modal.
   *
   * `installments` is only rendered for a LOAN — an advance is recovered in a
   * single deduction, so the field does not exist for it.
   */
  async submitRequest(opts: {
    type: 'ADVANCE' | 'LOAN';
    amount: number;
    installments?: number;
    reason?: string;
    /** Loan product to borrow under, by its visible name. */
    product?: string;
  }): Promise<void> {
    await this.page.getByTestId('loan-new').click();
    const modal = this.page.getByTestId('loan-create-modal');
    await modal.waitFor({ state: 'visible' });

    await modal.getByTestId(`loan-type-${opts.type}`).click();
    if (opts.product) {
      // The picker is only rendered when the catalogue offers something for
      // this flow, so a spec asking for a product must get a real failure
      // rather than a silent skip if it is not there.
      await modal
        .getByTestId('loan-product')
        .selectOption({ label: opts.product }, { timeout: 10_000 });
    }
    await modal.getByTestId('loan-amount').fill(String(opts.amount));
    if (opts.type === 'LOAN' && opts.installments != null) {
      await modal.getByTestId('loan-installments').fill(String(opts.installments));
    }
    if (opts.reason) await modal.getByTestId('loan-reason').fill(opts.reason);

    await modal.getByTestId('loan-submit').click();
    await modal.waitFor({ state: 'detached', timeout: 20_000 });
  }

  /**
   * Approves from the queue, optionally overriding the repayment period.
   *
   * The override is the point of the review modal: the requester states a
   * preference and the approver sets the number that the schedule is actually
   * built from.
   */
  async approve(loanId: string, opts: { installments?: number; note?: string } = {}): Promise<void> {
    await this.row(loanId).getByTestId('loan-approve').click();
    const modal = this.page.getByTestId('loan-review-modal');
    await modal.waitFor({ state: 'visible' });

    if (opts.installments != null) {
      await modal.getByTestId('loan-review-installments').fill(String(opts.installments));
    }
    if (opts.note) await modal.getByTestId('loan-review-note').fill(opts.note);

    await modal.getByTestId('loan-review-submit').click();
    await modal.waitFor({ state: 'detached', timeout: 20_000 });
  }

  async reject(loanId: string, reason: string): Promise<void> {
    await this.row(loanId).getByTestId('loan-reject').click();
    const modal = this.page.getByTestId('loan-review-modal');
    await modal.waitFor({ state: 'visible' });
    await modal.getByTestId('loan-review-note').fill(reason);
    await modal.getByTestId('loan-review-submit').click();
    await modal.waitFor({ state: 'detached', timeout: 20_000 });
  }
}

export class LoanDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/advance-loans/${id}`);
  }

  async status(): Promise<string | null> {
    return this.page.getByTestId('loan-status').getAttribute('data-status');
  }

  /** The agreed repayment period, as the Terms block reports it. */
  async installments(): Promise<string> {
    return (await this.page.getByTestId('loan-installments-value').innerText()).trim();
  }

  /** One row per live instalment. A schedule only exists once approved. */
  async scheduleRowCount(): Promise<number> {
    return this.page.getByTestId('loan-schedule-row').count();
  }
}

/**
 * The wage-file screen for one payroll run.
 *
 * Pre-flight is re-runnable and writes nothing, so `recheck()` is the honest way
 * to prove a fix took: fix the data over the API, press it, and the report has
 * to change.
 */
export class WpsPage {
  constructor(private readonly page: Page) {}

  async open(payrollId: string): Promise<void> {
    await open(this.page, `/dashboard/payroll/${payrollId}/wps`);
  }

  private get preflight() {
    return this.page.getByTestId('wps-preflight');
  }

  async preflightVisible(): Promise<boolean> {
    return this.preflight.isVisible().catch(() => false);
  }

  /** The report's own numbers, read from the panel rather than recomputed. */
  async report(): Promise<{
    canGenerate: boolean;
    ready: number;
    total: number;
    blocked: number;
    runBlockers: number;
  }> {
    const el = this.preflight;
    const attr = async (name: string) => (await el.getAttribute(name)) ?? '';
    return {
      canGenerate: (await attr('data-can-generate')) === 'true',
      ready: Number(await attr('data-ready')),
      total: Number(await attr('data-total')),
      blocked: Number(await attr('data-blocked')),
      runBlockers: Number(await attr('data-run-blockers')),
    };
  }

  async blockedEmployeeCount(): Promise<number> {
    return this.page.getByTestId('wps-blocked-employee').count();
  }

  async generateEnabled(): Promise<boolean> {
    return this.page.getByTestId('wps-generate').isEnabled().catch(() => false);
  }

  async recheck(): Promise<void> {
    await this.page.getByTestId('wps-recheck').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /**
   * Ticks every warning the report insists on before generating.
   *
   * Warnings are advisory but must be consciously accepted, and which ones
   * appear depends on the data — `SALARY_DEVIATION` only shows up once an
   * employee has three locked runs behind them, so a spec that assumed none
   * would pass early and stop working later.
   */
  async acknowledgeAll(): Promise<string[]> {
    const boxes = this.page.getByTestId('wps-acknowledge');
    const codes: string[] = [];
    for (let i = 0; i < (await boxes.count()); i++) {
      const box = boxes.nth(i);
      codes.push((await box.getAttribute('data-code')) ?? '');
      await box.check();
    }
    return codes;
  }

  async generate(): Promise<void> {
    await this.acknowledgeAll();
    await this.page.getByTestId('wps-generate').click();
    await this.page.getByTestId('wps-file').waitFor({ state: 'visible', timeout: 30_000 });
  }

  async file(): Promise<{ status: string; version: string; fileName: string; employeeCount: number }> {
    const el = this.page.getByTestId('wps-file');
    const attr = async (name: string) => (await el.getAttribute(name)) ?? '';
    return {
      status: await attr('data-file-status'),
      version: await attr('data-file-version'),
      fileName: await attr('data-file-name'),
      employeeCount: Number(await attr('data-employee-count')),
    };
  }

  async fileRowCount(): Promise<number> {
    return this.page.getByTestId('wps-file-row').count();
  }

  /**
   * Clicks Download and returns the bytes the browser was handed.
   *
   * The click is the whole test: the file is fetched by an authenticated XHR and
   * handed over as an object URL, so a plain link would 401 and a spec that only
   * asserted the button exists would not notice.
   */
  async download(): Promise<Buffer> {
    const waitForDownload = this.page.waitForEvent('download', { timeout: 30_000 });
    await this.page.getByTestId('wps-download').click();
    const download = await waitForDownload;
    const path = await download.path();
    if (!path) throw new Error('the browser produced no file for the download');
    const { readFile } = await import('fs/promises');
    return readFile(path);
  }
}

/**
 * The employee Excel importer, which is two phases on purpose: preview parses
 * and validates without writing anything, and only confirm creates people.
 */
export class EmployeeImportModal {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/employees');
    await this.page.getByTestId('employees-import-open').click();
    await this.page.getByTestId('import-modal').waitFor({ state: 'visible' });
  }

  async step(): Promise<string | null> {
    return this.page.getByTestId('import-modal').getAttribute('data-step');
  }

  /** Feeds a workbook built in memory — no fixture file on disk to drift. */
  async choose(file: { name: string; buffer: Buffer }): Promise<void> {
    await this.page.getByTestId('import-file-input').setInputFiles({
      name: file.name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: file.buffer,
    });
  }

  async upload(): Promise<void> {
    await this.page.getByTestId('import-upload').click();
    await this.page.getByTestId('import-preview').waitFor({ state: 'visible', timeout: 30_000 });
  }

  async preview(): Promise<{ total: number; valid: number; invalid: number }> {
    const el = this.page.getByTestId('import-preview');
    const attr = async (name: string) => Number((await el.getAttribute(name)) ?? '0');
    return {
      total: await attr('data-total-rows'),
      valid: await attr('data-valid-rows'),
      invalid: await attr('data-invalid-rows'),
    };
  }

  async confirm(): Promise<void> {
    await this.page.getByTestId('import-confirm').click();
    await this.page.getByTestId('import-results').waitFor({ state: 'visible', timeout: 60_000 });
  }

  async results(): Promise<{ succeeded: number; failed: number }> {
    const el = this.page.getByTestId('import-results');
    const attr = async (name: string) => Number((await el.getAttribute(name)) ?? '0');
    return { succeeded: await attr('data-success-count'), failed: await attr('data-failed-count') };
  }
}

export class SidebarNav {
  constructor(private readonly page: Page) {}

  /** Every destination currently offered. Keyed on href, never on label. */
  async links(): Promise<string[]> {
    return this.page.locator('a[href^="/dashboard"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('href') ?? ''),
    );
  }

  async offers(href: string): Promise<boolean> {
    return (await this.links()).includes(href);
  }
}

/**
 * Clocking in and out.
 *
 * The one screen in this app where the critical action is not a form submit:
 * `FaceCheckIn` opens a camera, and the check-in payload is a frame taken from
 * it. The synthetic camera is configured once in `playwright.config.ts` — see
 * `launchOptions` there for why the suite cannot test attendance without it.
 */
export class AttendanceClockPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-attendance');
  }

  /**
   * Today's state as the screen reports it: `checked-in`, `checked-out`,
   * `lunch`, or null when nothing has been clocked yet. Read from an attribute
   * rather than the banner text, which is translated.
   */
  async state(): Promise<string | null> {
    const banner = this.page.getByTestId('attendance-state');
    if (!(await banner.count())) return null;
    return banner.first().getAttribute('data-state');
  }

  async expectState(expected: string | null): Promise<void> {
    await expect.poll(() => this.state(), { timeout: 20_000 }).toBe(expected);
  }

  async canCheckIn(): Promise<boolean> {
    const btn = this.page.getByTestId('attendance-check-in');
    return (await btn.count()) > 0 && (await btn.isEnabled());
  }

  async canCheckOut(): Promise<boolean> {
    const btn = this.page.getByTestId('attendance-check-out');
    return (await btn.count()) > 0 && (await btn.isEnabled());
  }

  /**
   * Opens the camera, waits for the shutter to arm, takes the shot and closes
   * the confirmation. The shutter stays disabled until `loadedmetadata` fires
   * on the video element, so the enabled-state wait is load-bearing rather than
   * defensive.
   */
  private async capture(which: 'attendance-check-in' | 'attendance-check-out'): Promise<void> {
    await this.page.getByTestId(which).click();
    const shutter = this.page.getByTestId('webcam-shutter');
    await expect(shutter).toBeEnabled({ timeout: 20_000 });
    await shutter.click();
    // The success screen. Its presence is the proof the request was accepted —
    // an error keeps the camera open and shows a banner instead.
    const done = this.page.getByTestId('face-capture-done');
    await expect(done).toBeVisible({ timeout: 20_000 });
    await done.click();
  }

  async checkIn(): Promise<void> {
    await this.capture('attendance-check-in');
  }

  async checkOut(): Promise<void> {
    await this.capture('attendance-check-out');
  }

  /** How many sessions the timeline shows for today. 0 when it is not rendered. */
  async sessionCount(): Promise<number> {
    const badge = this.page.getByTestId('attendance-session-count');
    if (!(await badge.count())) return 0;
    return Number((await badge.getAttribute('data-count')) ?? '0');
  }

  /** True when the day is being measured against required hours, not a fixed shift. */
  async isFlexible(): Promise<boolean> {
    return (await this.page.getByTestId('attendance-hours').getAttribute('data-flexible')) === 'true';
  }
}

/**
 * Attendance corrections — the regularisation path.
 *
 * Two roles on one screen: an employee sees only their own requests and a
 * quota badge, HR sees everyone's and the approve/reject controls. The screen
 * decides which by role, so the same page object serves both.
 */
export class AttendanceCorrectionsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance/corrections');
  }

  async canRequest(): Promise<boolean> {
    return this.page.getByTestId('correction-new').isVisible().catch(() => false);
  }

  async openForm(): Promise<void> {
    await this.page.getByTestId('correction-new').click();
    await expect(this.page.getByTestId('correction-form')).toBeVisible();
  }

  async fill(opts: { date: string; checkIn?: string; checkOut?: string; reason: string }): Promise<void> {
    await this.page.getByTestId('correction-date').fill(opts.date);
    if (opts.checkIn) await this.page.getByTestId('correction-in').fill(opts.checkIn);
    if (opts.checkOut) await this.page.getByTestId('correction-out').fill(opts.checkOut);
    await this.page.getByTestId('correction-reason').fill(opts.reason);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('correction-submit').click();
  }

  /** True while the create form is still on screen — i.e. the submit did not go through. */
  async formStillOpen(): Promise<boolean> {
    return this.page.getByTestId('correction-form').isVisible().catch(() => false);
  }

  private row(id: string) {
    return this.page.locator(`[data-testid="correction-row"][data-correction-id="${id}"]`);
  }

  async rowStatus(id: string): Promise<string | null> {
    return this.row(id).getAttribute('data-status');
  }

  async expectRowStatus(id: string, expected: string): Promise<void> {
    await expect.poll(() => this.rowStatus(id), { timeout: 15_000 }).toBe(expected);
  }

  async hasRow(id: string): Promise<boolean> {
    return (await this.row(id).count()) > 0;
  }

  async canReview(id: string): Promise<boolean> {
    return this.row(id).getByTestId('correction-approve').isVisible().catch(() => false);
  }

  /**
   * Approve or reject through the review modal. A rejection must carry a reason.
   *
   * THREE steps, not two: the row button opens the shared `ConfirmModal` first,
   * and only after that is confirmed does the note-taking review modal appear.
   */
  async review(id: string, action: 'approve' | 'reject', note: string): Promise<void> {
    await this.row(id).getByTestId(action === 'approve' ? 'correction-approve' : 'correction-reject').click();
    await this.page.getByTestId('confirm-modal-confirm').click();
    await expect(this.page.getByTestId('correction-review-modal')).toBeVisible();
    await this.page.getByTestId('correction-review-note').fill(note);
    await this.page.getByTestId('correction-review-submit').click();
  }

  /** How many requests the current row set holds. */
  async rowCount(): Promise<number> {
    return this.page.getByTestId('correction-row').count();
  }
}

export class OvertimeRequestPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/overtime/new');
  }

  /**
   * Every field is optional so a case can change ONE input and watch the live
   * preview react — which is most of what this form is for.
   */
  async fill(opts: {
    date?: string;
    start?: string;
    end?: string;
    reason?: string;
  }): Promise<void> {
    if (opts.date !== undefined) await this.page.getByTestId('overtime-date').fill(opts.date);
    if (opts.start !== undefined) await this.page.getByTestId('overtime-start').fill(opts.start);
    if (opts.end !== undefined) await this.page.getByTestId('overtime-end').fill(opts.end);
    if (opts.reason !== undefined) {
      await this.page.locator('textarea').first().fill(opts.reason);
    }
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('overtime-submit').click();
  }

  /** Still on /new means the form refused it — which is what a validation test wants. */
  async stillOnForm(): Promise<boolean> {
    return this.page.getByTestId('overtime-submit').isVisible().catch(() => false);
  }

  /**
   * Every validation message currently rendered under a field.
   *
   * Reads the per-field ids rather than the `p.text-status-error` CLASS the
   * screen happens to use — a styling change must not silently empty this list
   * and turn a refusal assertion green.
   */
  async fieldErrors(): Promise<string[]> {
    return this.page.locator('[data-testid^="ot-error-"]').allInnerTexts();
  }

  async fieldError(field: 'date' | 'start' | 'end' | 'reason'): Promise<string | null> {
    const el = this.page.getByTestId(`ot-error-${field}`);
    if (!(await el.count())) return null;
    return el.first().innerText();
  }

  /** The live payable preview, or null while it is still hidden. */
  async preview(): Promise<{
    totalHours: number;
    otType: string;
    foodAllowance: number;
    clamped: boolean;
  } | null> {
    const el = this.page.getByTestId('ot-preview');
    if (!(await el.count())) return null;
    return {
      totalHours: num(await el.getAttribute('data-total-hours')),
      otType: (await el.getAttribute('data-ot-type')) ?? '',
      foodAllowance: num(await el.getAttribute('data-food-allowance')),
      clamped: (await el.getAttribute('data-clamped')) === 'true',
    };
  }

  async tierHours(tier: 'regular' | 'late' | 'double'): Promise<number> {
    const el = this.page.locator(`[data-testid="ot-preview-tier"][data-tier="${tier}"]`);
    if (!(await el.count())) return 0;
    return num(await el.getAttribute('data-hours'));
  }

  async dayClass(): Promise<string | null> {
    const el = this.page.getByTestId('ot-day-class');
    if (!(await el.count())) return null;
    return el.getAttribute('data-day-class');
  }

  async hasClampNote(): Promise<boolean> {
    return this.page.getByTestId('ot-clamp-note').isVisible().catch(() => false);
  }
}

export class OvertimeListPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/overtime');
  }

  async openMine(): Promise<void> {
    await open(this.page, '/dashboard/my-overtime');
  }

  async hasRow(id: string): Promise<boolean> {
    return (await this.page.locator(`[data-testid="overtime-row"][data-overtime-id="${id}"]`).count()) > 0;
  }

  async rowStatus(id: string): Promise<string | null> {
    return this.page.locator(`[data-testid="overtime-row"][data-overtime-id="${id}"]`).getAttribute('data-status');
  }

  async firstRowId(): Promise<string | null> {
    const rows = this.page.getByTestId('overtime-row');
    if (!(await rows.count())) return null;
    return rows.first().getAttribute('data-overtime-id');
  }

  async rowIds(): Promise<string[]> {
    return this.page
      .getByTestId('overtime-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-overtime-id') ?? ''));
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('overtime-row').count();
  }

  private row(id: string) {
    return this.page.locator(`[data-testid="overtime-row"][data-overtime-id="${id}"]`);
  }

  async rowHours(id: string): Promise<number> {
    return num(await this.row(id).getAttribute('data-hours'));
  }

  async rowOtType(id: string): Promise<string | null> {
    return this.row(id).getAttribute('data-ot-type');
  }

  async rowFoodAllowance(id: string): Promise<number> {
    return num(await this.row(id).getAttribute('data-food-allowance'));
  }

  /** `prefix` differs between the admin list and my-overtime. */
  async filter(
    key: 'all' | 'PENDING' | 'APPROVED' | 'REJECTED',
    prefix: 'ot' | 'my-ot' = 'ot',
  ): Promise<void> {
    await this.page.locator(`[data-testid="${prefix}-filter"][data-key="${key}"]`).click();
  }

  async activeFilter(prefix: 'ot' | 'my-ot' = 'ot'): Promise<string | null> {
    const active = this.page.locator(`[data-testid="${prefix}-filter"][data-active="true"]`);
    if (!(await active.count())) return null;
    return active.first().getAttribute('data-key');
  }

  async stat(
    key: 'total' | 'pending' | 'approved' | 'rejected' | 'hours',
    prefix: 'ot' | 'my-ot' = 'ot',
  ): Promise<number> {
    return num(
      await this.page
        .locator(`[data-testid="${prefix}-stat"][data-key="${key}"]`)
        .getAttribute('data-value'),
    );
  }

  async isEmpty(prefix: 'ot' | 'my-ot' = 'ot'): Promise<boolean> {
    return this.page.getByTestId(`${prefix}-empty`).isVisible().catch(() => false);
  }

  /** The employee column exists only for ADMIN and HR. */
  async hasEmployeeColumn(): Promise<boolean> {
    return (await this.page.getByTestId('ot-employee-cell').count()) > 0;
  }

  async openDetails(id: string): Promise<void> {
    await this.row(id).getByTestId('overtime-details').click();
  }
}

/**
 * The approver's review-and-edit screen for one overtime request.
 *
 * Opened from the approvals inbox ("View details") and from the overtime detail
 * page's Approve button — one component behind both, so a correction offered on
 * one screen is offered on the other.
 */
export class OvertimeReviewModal {
  constructor(private readonly page: Page) {}

  private root() {
    return this.page.getByTestId('ot-review-modal');
  }

  async waitForOpen(): Promise<void> {
    await expect(this.root()).toBeVisible({ timeout: 15_000 });
  }

  async requestId(): Promise<string | null> {
    return this.root().getAttribute('data-request-id');
  }

  /** The worked window as rendered, e.g. `18:00 – 20:00`. */
  async window(): Promise<string> {
    return (await this.page.getByTestId('ot-review-window').innerText()).trim();
  }

  async hours(): Promise<number> {
    const v = await this.page.getByTestId('ot-review-hours').getAttribute('data-hours');
    return Number(v ?? 0);
  }

  async otType(): Promise<string | null> {
    return this.page.getByTestId('ot-review-breakdown').getAttribute('data-ot-type');
  }

  async foodAllowance(): Promise<number> {
    const v = await this.page
      .getByTestId('ot-review-breakdown')
      .getAttribute('data-food-allowance');
    return Number(v ?? 0);
  }

  async siteAllowance(): Promise<number> {
    const v = await this.page
      .getByTestId('ot-review-breakdown')
      .getAttribute('data-site-allowance');
    return Number(v ?? 0);
  }

  async canEdit(): Promise<boolean> {
    return this.page.getByTestId('ot-review-start').isVisible().catch(() => false);
  }

  async canAddSiteAllowance(): Promise<boolean> {
    return this.page
      .getByTestId('ot-review-site-toggle')
      .isVisible()
      .catch(() => false);
  }

  /**
   * `hhmm` is WALL-CLOCK, exactly as the employee entered it. Overtime stamps
   * are tz-naive tagged `Z`, so no offset is applied anywhere in this flow.
   */
  async setEnd(hhmm: string): Promise<void> {
    await this.page.getByTestId('ot-review-end').fill(hhmm);
  }

  async setStart(hhmm: string): Promise<void> {
    await this.page.getByTestId('ot-review-start').fill(hhmm);
  }

  /**
   * Waits for the server dry run to land on a given payable total.
   *
   * Polling the FIGURE, not the spinner: the request is debounced, so at the
   * moment an edit is typed the spinner has not appeared yet and a
   * "wait for no spinner" check passes instantly against the stale number.
   */
  async expectHours(expected: number): Promise<void> {
    await expect.poll(() => this.hours(), { timeout: 15_000 }).toBe(expected);
  }

  async expectOtType(expected: string): Promise<void> {
    await expect.poll(() => this.otType(), { timeout: 15_000 }).toBe(expected);
  }

  /** Waits for any in-flight dry run to finish before reading a value. */
  async settlePricing(): Promise<void> {
    // Past the 350ms debounce first, or the spinner has not been raised yet.
    await this.page.waitForTimeout(500);
    await expect(this.page.getByTestId('ot-review-pricing')).toHaveCount(0, {
      timeout: 15_000,
    });
  }

  async addSiteAllowance(amount: number, note?: string): Promise<void> {
    await this.page.getByTestId('ot-review-site-toggle').check();
    await this.page.getByTestId('ot-review-site-amount').fill(String(amount));
    if (note) await this.page.getByTestId('ot-review-site-note').fill(note);
  }

  async siteError(): Promise<string | null> {
    const el = this.page.getByTestId('ot-review-site-error');
    return (await el.count()) ? (await el.innerText()).trim() : null;
  }

  async setNote(text: string): Promise<void> {
    await this.page.getByTestId('ot-review-note').fill(text);
  }

  async approveDisabled(): Promise<boolean> {
    return this.page.getByTestId('ot-review-approve').isDisabled();
  }

  async approve(): Promise<void> {
    await this.page.getByTestId('ot-review-approve').click();
  }

  async reject(reason: string): Promise<void> {
    await this.page.getByTestId('ot-review-reject-open').click();
    await this.page.getByTestId('ot-review-reject-reason').fill(reason);
    await this.page.getByTestId('ot-review-reject-confirm').click();
  }

  async error(): Promise<string | null> {
    const el = this.page.getByTestId('ot-review-error');
    return (await el.count()) ? (await el.innerText()).trim() : null;
  }

  async close(): Promise<void> {
    await this.page.getByTestId('ot-review-close').click();
  }
}

export class OvertimeDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/overtime/${id}`);
  }

  async status(): Promise<string | null> {
    return this.page.getByTestId('overtime-status').getAttribute('data-status');
  }

  async expectStatus(expected: string): Promise<void> {
    await expect.poll(() => this.status(), { timeout: 15_000 }).toBe(expected);
  }

  async canApprove(): Promise<boolean> {
    return this.page.getByTestId('overtime-approve').isVisible().catch(() => false);
  }

  /**
   * Two steps: the button opens the review screen, and the decision is taken
   * there. It replaced a plain confirm dialog when approvers gained the ability
   * to correct a request while approving it — the inbox opens the SAME screen,
   * so the two approve paths cannot drift apart.
   */
  async approve(): Promise<void> {
    await this.page.getByTestId('overtime-approve').click();
    await this.page.getByTestId('ot-review-approve').click();
  }

  /** The review screen this page opens; see {@link OvertimeReviewModal}. */
  review(): OvertimeReviewModal {
    return new OvertimeReviewModal(this.page);
  }

  async openReview(): Promise<OvertimeReviewModal> {
    await this.page.getByTestId('overtime-approve').click();
    const modal = this.review();
    await modal.waitForOpen();
    return modal;
  }

  async reject(reason: string): Promise<void> {
    await this.page.getByTestId('overtime-reject-open').click();
    await this.page.getByTestId('overtime-reject-reason').fill(reason);
    await this.page.getByTestId('overtime-reject-confirm').click();
  }

  async canReject(): Promise<boolean> {
    return this.page.getByTestId('overtime-reject-open').isVisible().catch(() => false);
  }

  async canCancel(): Promise<boolean> {
    return this.page.getByTestId('overtime-cancel').isVisible().catch(() => false);
  }

  async cancel(): Promise<void> {
    await this.page.getByTestId('overtime-cancel').click();
    await this.page.getByTestId('confirm-modal-confirm').click();
  }

  /**
   * Whether the reject button is DISABLED without a reason.
   *
   * The screen both disables the button and re-checks inside the handler with a
   * toast — one of the two is unreachable from the UI. Assert the state that is
   * actually reachable.
   */
  async rejectDisabledWithoutReason(): Promise<boolean> {
    await this.page.getByTestId('overtime-reject-open').click();
    return this.page.getByTestId('overtime-reject-confirm').isDisabled();
  }

  async breakdown(): Promise<{
    otType: string;
    totalHours: number;
    foodAllowance: number;
  } | null> {
    const el = this.page.getByTestId('ot-breakdown');
    if (!(await el.count())) return null;
    return {
      otType: (await el.getAttribute('data-ot-type')) ?? '',
      totalHours: num(await el.getAttribute('data-total-hours')),
      foodAllowance: num(await el.getAttribute('data-food-allowance')),
    };
  }

  async pay(): Promise<{ total: number; hourlyRate: number } | null> {
    const el = this.page.getByTestId('ot-pay');
    if (!(await el.count())) return null;
    return {
      total: num(await el.getAttribute('data-total')),
      hourlyRate: num(await el.getAttribute('data-hourly-rate')),
    };
  }

  async rejectionReason(): Promise<string | null> {
    const el = this.page.getByTestId('ot-rejection-reason');
    if (!(await el.count())) return null;
    return el.innerText();
  }

  trail(): ApprovalTrailPanel {
    return new ApprovalTrailPanel(this.page, 'ot');
  }

  async notFound(): Promise<boolean> {
    return this.page.getByTestId('ot-not-found').isVisible().catch(() => false);
  }
}

/**
 * Reimbursements.
 *
 * Worth a browser test rather than an API one because approval here has a
 * downstream money effect: an approved claim is picked up by the next payroll
 * run, so a screen that reports success without persisting leaves an employee
 * unpaid with no error anywhere.
 */
export class ReimbursementsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/reimbursements');
  }

  /**
   * Moves to a named tab and waits for its rows.
   *
   * Not cosmetic: the approve/reject controls are rendered only where
   * `activeTab !== 'my'`, and the default tab is chosen asynchronously once the
   * screen knows whether this role is an approver. A spec that asserts before
   * that settles is reading the requester's tab and concludes, wrongly, that
   * the approver was offered nothing.
   */
  async openTab(key: 'pending' | 'my' | 'all'): Promise<void> {
    const tab = this.page.getByTestId(`reimb-tab-${key}`);
    if (!(await tab.count())) return;
    await tab.click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async canRequest(): Promise<boolean> {
    return this.page.getByTestId('reimb-new').isVisible().catch(() => false);
  }

  async openForm(): Promise<void> {
    await this.page.getByTestId('reimb-new').click();
    await expect(this.page.getByTestId('reimb-form')).toBeVisible();
  }

  /** Picks the first real option; the list is admin-configured, so no type is hardcoded. */
  async fill(opts: { amount: string; date: string; description: string }): Promise<void> {
    const type = this.page.getByTestId('reimb-type');
    const values = await type.locator('option').evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
    );
    if (!values.length) throw new Error('No reimbursement types are configured — the baseline seed did not run');
    await type.selectOption(values[0]);
    await this.page.getByTestId('reimb-amount').fill(opts.amount);
    await this.page.getByTestId('reimb-date').fill(opts.date);
    await this.page.getByTestId('reimb-description').fill(opts.description);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('reimb-submit').click();
  }

  private row(id: string) {
    return this.page.locator(`[data-testid="reimb-row"][data-reimb-id="${id}"]`);
  }

  async hasRow(id: string): Promise<boolean> {
    return (await this.row(id).count()) > 0;
  }

  async rowStatus(id: string): Promise<string | null> {
    return this.row(id).getAttribute('data-status');
  }

  async expectRowStatus(id: string, expected: string): Promise<void> {
    await expect.poll(() => this.rowStatus(id), { timeout: 15_000 }).toBe(expected);
  }

  async canReview(id: string): Promise<boolean> {
    return this.row(id).getByTestId('reimb-approve').isVisible().catch(() => false);
  }

  async review(id: string, action: 'approve' | 'reject', note: string): Promise<void> {
    await this.row(id).getByTestId(action === 'approve' ? 'reimb-approve' : 'reimb-reject').click();
    await expect(this.page.getByTestId('reimb-review-modal')).toBeVisible();
    await this.page.getByTestId('reimb-review-note').fill(note);
    await this.page.getByTestId('reimb-review-submit').click();
  }
}

/**
 * The cross-module approvals inbox.
 *
 * Its blast radius is the reason it is here: every kind it can show is looked
 * up in `APPROVAL_KIND_UI`, and an unregistered kind renders a row whose
 * buttons cannot do anything. That is invisible until someone tries to approve.
 */
export class ApprovalsInboxPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/approvals');
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('approval-empty').isVisible().catch(() => false);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('approval-row').count();
  }

  /** The request kinds currently in the inbox, e.g. LEAVE, OVERTIME. */
  async kinds(): Promise<string[]> {
    return this.page
      .getByTestId('approval-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-request-type') ?? ''));
  }

  private row(requestId: string) {
    return this.page.locator(`[data-testid="approval-row"][data-request-id="${requestId}"]`);
  }

  async has(requestId: string): Promise<boolean> {
    return (await this.row(requestId).count()) > 0;
  }

  /** The card's fast path: approve exactly as filed, no payload. */
  async approve(requestId: string): Promise<void> {
    await this.row(requestId).getByTestId('approval-approve').click();
  }

  /** Whether this row offers a review screen (overtime does; leave does not). */
  async canReview(requestId: string): Promise<boolean> {
    return (await this.row(requestId).getByTestId('approval-details').count()) > 0;
  }

  /** Opens the review-and-edit screen for one row. */
  async review(requestId: string): Promise<OvertimeReviewModal> {
    await this.row(requestId).getByTestId('approval-details').click();
    const modal = new OvertimeReviewModal(this.page);
    await modal.waitForOpen();
    return modal;
  }

  /** The one-line summary the card renders, e.g. `20 Aug 2026 · 18:00–20:00 · 2h`. */
  async summary(requestId: string): Promise<string> {
    return (await this.row(requestId).innerText()).trim();
  }

  async reject(requestId: string, reason: string): Promise<void> {
    const row = this.row(requestId);
    await row.getByTestId('approval-reject-open').click();
    await row.getByTestId('approval-reject-reason').fill(reason);
    await row.getByTestId('approval-reject-confirm').click();
  }

  async steps(): Promise<
    Array<{ requestId: string; requestType: string; stepOrder: number; approverType: string }>
  > {
    return this.page.getByTestId('approval-row').evaluateAll((els) =>
      els.map((e) => ({
        requestId: e.getAttribute('data-request-id') ?? '',
        requestType: e.getAttribute('data-request-type') ?? '',
        stepOrder: Number(e.getAttribute('data-step-order') ?? 0),
        approverType: e.getAttribute('data-approver-type') ?? '',
      })),
    );
  }

  async isLoading(): Promise<boolean> {
    return this.page.getByTestId('approval-loading').isVisible().catch(() => false);
  }
}

/**
 * System settings.
 *
 * A 4600-line screen whose values gate whole modules elsewhere. Only the tab
 * switch, one numeric field and the save button are modelled — the point of the
 * journey is that a saved value survives a reload and reaches the screen that
 * reads it, not that every control on this page works.
 */
export class SettingsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/settings');
  }

  async hasTab(id: string): Promise<boolean> {
    return this.page.getByTestId(`settings-tab-${id}`).isVisible().catch(() => false);
  }

  async openTab(id: string): Promise<void> {
    await this.page.getByTestId(`settings-tab-${id}`).click();
  }

  async correctionLimit(): Promise<string> {
    return this.page.getByTestId('setting-correction-limit').inputValue();
  }

  async setCorrectionLimit(value: string): Promise<void> {
    await this.page.getByTestId('setting-correction-limit').fill(value);
  }

  async save(): Promise<void> {
    await this.page.getByTestId('settings-save').click();
  }

  async canSave(): Promise<boolean> {
    return this.page.getByTestId('settings-save').isVisible().catch(() => false);
  }
}

/** The employee's own payslip list and one payslip. */
export class PayslipsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/payroll');
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('payslip-row').count();
  }

  /**
   * Narrows the list to one year.
   *
   * The screen defaults to `new Date().getFullYear()` and filters client-side,
   * so a payslip for any other year is simply not in the DOM — which reads as
   * "the employee has no payslips" rather than "the filter is hiding it".
   */
  async selectYear(year: number): Promise<void> {
    const select = this.page.getByTestId('payslip-year');
    if (!(await select.count())) return;
    await select.selectOption(String(year));
  }

  async firstPayrollId(): Promise<string | null> {
    const rows = this.page.getByTestId('payslip-row');
    if (!(await rows.count())) return null;
    return rows.first().getAttribute('data-payroll-id');
  }

  /** Opens a payslip the way an employee does — by clicking, not by URL. */
  async openFirst(): Promise<void> {
    await this.page.getByTestId('payslip-view').first().click();
    await expect(this.page.getByTestId('payslip-net')).toBeVisible({ timeout: 20_000 });
  }

  /** The net figure as a number, read from the attribute rather than the formatted text. */
  async net(): Promise<number> {
    return Number((await this.page.getByTestId('payslip-net').getAttribute('data-net')) ?? 'NaN');
  }
}

/** One payroll run, as HR sees it. */
export class PayrollDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/payroll/${id}`);
  }

  async status(): Promise<string | null> {
    return this.page.getByTestId('payroll-detail-status').getAttribute('data-status');
  }

  async expectStatus(expected: string): Promise<void> {
    await expect.poll(() => this.status(), { timeout: 20_000 }).toBe(expected);
  }

  async canSubmit(): Promise<boolean> {
    return this.page.getByTestId('payroll-detail-submit').isVisible().catch(() => false);
  }

  async canLock(): Promise<boolean> {
    return this.page.getByTestId('payroll-detail-lock').isVisible().catch(() => false);
  }

  /** Only a LOCKED run offers a revision — the sole way to correct one. */
  async canRevise(): Promise<boolean> {
    return this.page.getByTestId('payroll-detail-revision').isVisible().catch(() => false);
  }

  /**
   * Submit and lock are confirmed through the app's ConfirmModal since Phase 4.
   * They used to raise a native `window.confirm`, which Playwright dismisses by
   * default — so the click looked like it did nothing.
   */
  async submit(): Promise<void> {
    await this.page.getByTestId('payroll-detail-submit').click();
    await confirmDialog(this.page);
  }

  async lock(): Promise<void> {
    await this.page.getByTestId('payroll-detail-lock').click();
    await confirmDialog(this.page);
  }

  /** A revision needs a reason; the server refuses an empty one. */
  async revise(reason: string): Promise<void> {
    await this.page.getByTestId('payroll-detail-revision').click();
    await this.page.getByTestId('payroll-revision-reason').fill(reason);
    await this.page.getByTestId('payroll-revision-confirm').click();
  }

  async openRevise(): Promise<void> {
    await this.page.getByTestId('payroll-detail-revision').click();
  }

  /** True while the revision dialog refuses to submit — i.e. the reason is empty. */
  async reviseBlocked(): Promise<boolean> {
    return this.page.getByTestId('payroll-revision-confirm').isDisabled();
  }

  // ── The run table ────────────────────────────────────────────────────────
  // Five summary cards and a six-column table with a per-row disclosure. The
  // old screen was eleven columns of raw payslip figures with no way in.

  /** The five summary cards, keyed by the slug in their testid. */
  card(key: 'employees' | 'gross' | 'deductions' | 'statutory' | 'net') {
    return this.page.getByTestId(`payroll-run-card-${key}`);
  }

  rows() {
    return this.page.getByTestId('payroll-run-row');
  }

  async rowCount(): Promise<number> {
    return this.rows().count();
  }

  /** One row by the payslip id it carries, so a filter cannot shift it under us. */
  row(itemId: string) {
    return this.page.locator(`[data-testid="payroll-run-row"][data-item-id="${itemId}"]`);
  }

  /** How many exceptions the row advertises, straight off its own attribute. */
  async rowExceptions(index = 0): Promise<number> {
    return Number(
      (await this.rows().nth(index).getAttribute('data-exceptions')) ?? '0',
    );
  }

  /** Opens the disclosure. The row itself is the target — the chevron is decoration. */
  async expandRow(index = 0): Promise<void> {
    await this.rows().nth(index).click();
  }

  async search(text: string): Promise<void> {
    await this.page.getByTestId('payroll-run-search').fill(text);
  }

  async toggleExceptionsOnly(): Promise<void> {
    await this.page.getByTestId('payroll-run-only-exceptions').click();
  }

  async exceptionsFilterEnabled(): Promise<boolean> {
    return this.page.getByTestId('payroll-run-only-exceptions').isEnabled();
  }

  /** Every exception chip on screen, as `{ kind, href }`. */
  async exceptionChips(): Promise<Array<{ kind: string; href: string }>> {
    return this.page
      .getByTestId('payroll-row-exception')
      .evaluateAll((els) =>
        els.map((e) => ({
          kind: e.getAttribute('data-exception') ?? '',
          href: e.getAttribute('href') ?? '',
        })),
      );
  }

  async editRow(index = 0): Promise<void> {
    await this.rows().nth(index).getByTestId('payroll-run-edit').click();
  }

  async fillEdit(field: string, value: string): Promise<void> {
    await this.page.getByTestId(`payroll-run-edit-${field}`).fill(value);
  }

  async saveEdit(): Promise<void> {
    await this.page.getByTestId('payroll-run-edit-save').click();
  }
}

/** The payroll approval queue — a separate screen from the run itself. */
export class PayrollApprovalsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/payroll/approvals');
  }

  private row(id: string) {
    return this.page.locator(`[data-testid="payroll-approval-row"][data-payroll-id="${id}"]`);
  }

  async has(id: string): Promise<boolean> {
    return (await this.row(id).count()) > 0;
  }

  async canApprove(id: string): Promise<boolean> {
    return this.row(id).getByTestId('payroll-approval-approve').isVisible().catch(() => false);
  }

  async canReject(id: string): Promise<boolean> {
    return this.row(id).getByTestId('payroll-approval-reject').isVisible().catch(() => false);
  }

  /**
   * Confirmed through the app's own ConfirmModal since Phase 4 — this screen
   * used to raise a native `window.confirm`, which Playwright dismisses by
   * default, so a click silently became a no-op unless a dialog handler was
   * installed first.
   */
  async approve(id: string): Promise<void> {
    await this.row(id).getByTestId('payroll-approval-approve').click();
    await confirmDialog(this.page);
  }

  /** Rejection needs a reason — the server refuses an empty one. */
  async reject(id: string, reason: string): Promise<void> {
    await this.row(id).getByTestId('payroll-approval-reject').click();
    await this.page.getByTestId('payroll-reject-reason').fill(reason);
    await this.page.getByTestId('payroll-reject-confirm').click();
  }

  /** True while the reject dialog refuses to submit — i.e. the reason is empty. */
  async rejectBlocked(): Promise<boolean> {
    return this.page.getByTestId('payroll-reject-confirm').isDisabled();
  }

  async openReject(id: string): Promise<void> {
    await this.row(id).getByTestId('payroll-approval-reject').click();
  }

  async count(): Promise<number> {
    return this.page.getByTestId('payroll-approval-row').count();
  }
}

/** `/dashboard/payroll/batches` — named, per-branch groups of employees. */
export class PayrollBatchesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/payroll/batches');
  }

  card(name: string) {
    return this.page.locator(`[data-testid="batch-card"][data-batch-name="${name}"]`);
  }

  async count(): Promise<number> {
    return this.page.getByTestId('batch-card').count();
  }

  async memberCount(name: string): Promise<number> {
    return num(await this.card(name).getAttribute('data-member-count'));
  }

  async isEmptyState(): Promise<boolean> {
    return this.page.getByTestId('batch-create-first').isVisible().catch(() => false);
  }

  async startCreate(): Promise<void> {
    const first = this.page.getByTestId('batch-create-first');
    if (await first.isVisible().catch(() => false)) await first.click();
    else await this.page.getByTestId('batch-create').click();
  }

  async fillName(name: string): Promise<void> {
    await this.page.getByTestId('batch-name').fill(name);
  }

  /** Clicks the row for an employee; the row records its own selected state. */
  async toggleEmployee(employeeId: string): Promise<void> {
    await this.page
      .locator(`[data-testid="batch-employee-row"][data-employee-id="${employeeId}"]`)
      .click();
  }

  async employeeVisible(employeeId: string): Promise<boolean> {
    return (
      (await this.page
        .locator(`[data-testid="batch-employee-row"][data-employee-id="${employeeId}"]`)
        .count()) > 0
    );
  }

  async save(): Promise<void> {
    await this.page.getByTestId('batch-modal-save').click();
  }

  async edit(name: string): Promise<void> {
    await this.card(name).getByTestId('batch-edit').click();
  }

  async delete(name: string): Promise<void> {
    await this.card(name).getByTestId('batch-delete').click();
  }

  async runPayroll(name: string): Promise<void> {
    await this.card(name).getByTestId('batch-run-payroll').click();
  }
}

/** `/dashboard/payroll/salary-structure` — an employee's active components. */
export class SalaryStructurePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/payroll/salary-structure');
  }

  row(componentId: string) {
    return this.page.locator(`[data-testid="sc-row"][data-component-id="${componentId}"]`);
  }

  rowsOfType(type: string) {
    return this.page.locator(`[data-testid="sc-row"][data-component-type="${type}"]`);
  }

  async amountOf(componentId: string): Promise<number> {
    return num(await this.row(componentId).getAttribute('data-amount'));
  }

  async canAdd(): Promise<boolean> {
    return this.page.getByTestId('sc-add').isVisible().catch(() => false);
  }

  async canDelete(componentId: string): Promise<boolean> {
    return this.row(componentId).getByTestId('sc-delete').isVisible().catch(() => false);
  }

  async startAdd(): Promise<void> {
    await this.page.getByTestId('sc-add').click();
  }

  async fill(values: {
    employeeId?: string;
    type?: string;
    amount?: number;
    effectiveDate?: string;
    note?: string;
  }): Promise<void> {
    if (values.employeeId !== undefined) {
      await this.page.getByTestId('sc-employee').selectOption(values.employeeId);
    }
    if (values.type !== undefined) {
      await this.page.getByTestId('sc-type').selectOption(values.type);
    }
    if (values.amount !== undefined) {
      await this.page.getByTestId('sc-amount').fill(String(values.amount));
    }
    if (values.effectiveDate !== undefined) {
      await this.page.getByTestId('sc-effective-date').fill(values.effectiveDate);
    }
    if (values.note !== undefined) {
      await this.page.getByTestId('sc-note').fill(values.note);
    }
  }

  async save(): Promise<void> {
    await this.page.getByTestId('sc-modal-save').click();
  }

  async edit(componentId: string): Promise<void> {
    // The list is grouped per employee and can be long, so wait for the row and
    // bring it into view before reaching for its controls — a row that exists
    // but has never been scrolled to reports its buttons as unclickable.
    const row = this.row(componentId);
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.scrollIntoViewIfNeeded();
    await row.getByTestId('sc-edit').click();
  }
}

/** `/dashboard/banks` — the company-wide bank master. */
export class BanksPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks');
  }

  row(name: string) {
    return this.page.locator(`[data-testid="bank-row"][data-bank-name="${name}"]`);
  }

  async count(): Promise<number> {
    return this.page.getByTestId('bank-row').count();
  }

  async isActive(name: string): Promise<boolean> {
    return (await this.row(name).getAttribute('data-active')) === 'true';
  }

  async add(): Promise<void> {
    await this.page.getByTestId('bank-add').click();
  }
}

/** `/dashboard/banks/config` — the per-country banking field schema. */
export class BankFieldConfigPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/config');
  }

  async seedDefaults(): Promise<void> {
    await this.page.getByTestId('bankfield-seed').click();
  }

  async save(): Promise<void> {
    await this.page.getByTestId('bankfield-save').click();
  }
}

/** `/dashboard/banks/branch-countries` — which countries a branch may bank in. */
export class BranchCountriesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/branch-countries');
  }

  row(branchId: string) {
    return this.page.locator(`[data-testid="bankcountry-row"][data-branch-id="${branchId}"]`);
  }

  async save(branchId: string): Promise<void> {
    await this.row(branchId).getByTestId('bankcountry-save').click();
  }
}

/** `/dashboard/banks/migrate` — the legacy free-text → Bank Master backfill. */
export class BankMigrationPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/banks/migrate');
  }

  row(employeeId: string) {
    return this.page.locator(`[data-testid="migrate-row"][data-employee-id="${employeeId}"]`);
  }

  async count(): Promise<number> {
    return this.page.getByTestId('migrate-row').count();
  }

  async submit(employeeId: string): Promise<void> {
    await this.row(employeeId).getByTestId('migrate-submit').click();
  }
}

/**
 * The Payment Information card, mounted on `/dashboard/profile` and on an
 * employee's record. It never edits a bank detail directly — every change goes
 * through a `BankChangeRequest`.
 */
export class PaymentInformationSection {
  constructor(private readonly page: Page) {}

  async openOwn(): Promise<void> {
    await open(this.page, '/dashboard/profile');
  }

  async hasPendingBanner(): Promise<boolean> {
    return this.page.getByTestId('pay-info-pending').isVisible().catch(() => false);
  }

  async canRequestChange(): Promise<boolean> {
    return this.page.getByTestId('pay-info-request-change').isVisible().catch(() => false);
  }

  async startRequest(): Promise<void> {
    await this.page.getByTestId('pay-info-request-change').click();
  }

  async chooseBank(bankId: string): Promise<void> {
    await this.page.getByTestId('pay-info-bank').selectOption(bankId);
  }

  async fillField(key: string, value: string): Promise<void> {
    await this.page.getByTestId(`pay-info-field-${key}`).fill(value);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('pay-info-submit').click();
  }

  /** The server's reason for refusing THIS field, beside the field itself. */
  async fieldError(key: string): Promise<string | null> {
    const el = this.page.getByTestId(`pay-info-error-${key}`);
    return (await el.count()) ? el.innerText() : null;
  }
}

/**
 * Accepts native dialogs AND records what they said.
 *
 * The Organization screens report the outcome of a save or a delete through
 * `window.alert`, not through an in-page banner — so the server's reason for
 * refusing ("Branch code already exists", "Cannot delete department with
 * employees") exists only in a dialog. Dismissing it, which is Playwright's
 * default, throws away the only evidence the screen produced.
 */
export function captureNativeDialogs(page: Page): string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept().catch(() => {});
  });
  return messages;
}

/** Dismisses every native dialog, recording what was asked. */
export function dismissNativeDialogs(page: Page): string[] {
  const messages: string[] = [];
  page.on('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss().catch(() => {});
  });
  return messages;
}

// ── Organization: branches ──────────────────────────────────────────────────

export class BranchesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/branches');
  }

  card(code: string) {
    return this.page.getByTestId(`branch-card-${code}`);
  }

  row(code: string) {
    return this.page.getByTestId(`branch-row-${code}`);
  }

  async has(code: string): Promise<boolean> {
    return (await this.card(code).count()) > 0;
  }

  async stat(name: 'total' | 'active' | 'geofenced' | 'employees'): Promise<number> {
    const text = await this.page.getByTestId(`branch-stat-${name}`).innerText();
    return Number(text.trim());
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('branch-search').fill(term);
  }

  async showTable(): Promise<void> {
    await this.page.getByTestId('branch-view-table').click();
  }

  async showCards(): Promise<void> {
    await this.page.getByTestId('branch-view-card').click();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('branch-empty').isVisible().catch(() => false);
  }

  async create(): Promise<void> {
    await this.page.getByTestId('branch-new').click();
  }

  async canCreate(): Promise<boolean> {
    return this.page.getByTestId('branch-new').isVisible().catch(() => false);
  }

  /** Guarded by a native confirm — install a dialog handler first. */
  async delete(code: string): Promise<void> {
    await this.card(code).getByTestId('branch-card-delete').click();
  }

  /** Reveals retired branches, which the list filters out by default. */
  async toggleInactive(): Promise<void> {
    await this.page.getByTestId('branch-toggle-inactive').click();
  }

  /** Guarded by a native confirm — install a dialog handler first. */
  async reactivate(code: string): Promise<void> {
    await this.card(code).getByTestId('branch-card-reactivate').click();
  }

  async edit(code: string): Promise<void> {
    await this.card(code).getByTestId('branch-card-edit').click();
  }

  async openDetail(code: string): Promise<void> {
    await this.card(code).getByTestId('branch-card-details').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The office-hours pill, which reads "inherits default" when unset. */
  async hours(code: string): Promise<string> {
    return (await this.card(code).getByTestId('branch-card-hours').innerText()).trim();
  }

  async staff(code: string): Promise<number> {
    return Number((await this.card(code).getByTestId('branch-card-staff').innerText()).trim());
  }
}

export interface BranchInput {
  code?: string;
  name?: string;
  city?: string;
  country?: string;
  timezone?: string;
  officeStartTime?: string;
  officeEndTime?: string;
  weeklyOffDays?: string[];
  geofencing?: boolean;
  latitude?: string;
  longitude?: string;
  radius?: string;
}

export class BranchFormPage {
  constructor(private readonly page: Page) {}

  async openNew(): Promise<void> {
    await open(this.page, '/dashboard/branches/new');
  }

  async openEdit(id: string): Promise<void> {
    await open(this.page, `/dashboard/branches/${id}/edit`);
  }

  async fill(input: BranchInput): Promise<void> {
    const set = async (testId: string, value?: string) => {
      if (value === undefined) return;
      await this.page.getByTestId(testId).fill(value);
    };

    await set('branch-code', input.code);
    await set('branch-name', input.name);
    await set('branch-city', input.city);
    await set('branch-timezone', input.timezone);
    await set('branch-start-time', input.officeStartTime);
    await set('branch-end-time', input.officeEndTime);
    await set('branch-latitude', input.latitude);
    await set('branch-longitude', input.longitude);
    await set('branch-radius', input.radius);

    if (input.country !== undefined) {
      await this.page.getByTestId('branch-country').selectOption(input.country);
    }
    if (input.geofencing !== undefined) {
      const box = this.page.getByTestId('branch-geofencing');
      if ((await box.isChecked()) !== input.geofencing) await box.click();
    }
    for (const day of input.weeklyOffDays ?? []) {
      await this.page.getByTestId(`branch-weekoff-${day}`).click();
    }
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('branch-submit').click();
  }

  async geofenceFieldsEnabled(): Promise<boolean> {
    return this.page.getByTestId('branch-latitude').isEnabled();
  }

  async value(field: string): Promise<string> {
    return this.page.getByTestId(`branch-${field}`).inputValue();
  }

  /** The zod messages rendered under a field, in DOM order. */
  async fieldErrors(): Promise<string[]> {
    return this.page.locator('form .text-status-error').allInnerTexts();
  }
}

export class BranchDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/branches/${id}`);
  }

  async name(): Promise<string> {
    return (await this.page.getByTestId('branch-detail-name').innerText()).trim();
  }

  async staff(): Promise<number> {
    return Number((await this.page.getByTestId('branch-detail-staff').innerText()).trim());
  }

  async hours(): Promise<string> {
    return (await this.page.getByTestId('branch-detail-hours').innerText()).trim();
  }

  async timezone(): Promise<string> {
    return (await this.page.getByTestId('branch-detail-timezone').innerText()).trim();
  }

  async delete(): Promise<void> {
    await this.page.getByTestId('branch-detail-delete').click();
  }
}

// ── Organization: departments ───────────────────────────────────────────────

export class DepartmentsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/departments');
  }

  card(code: string) {
    return this.page.getByTestId(`dept-card-${code}`);
  }

  row(code: string) {
    return this.page.getByTestId(`dept-row-${code}`);
  }

  async has(code: string): Promise<boolean> {
    return (await this.card(code).count()) > 0;
  }

  async stat(name: 'total' | 'active' | 'toplevel' | 'teams'): Promise<number> {
    const text = await this.page.getByTestId(`dept-stat-${name}`).innerText();
    return Number(text.trim());
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('dept-search').fill(term);
  }

  async showAdvancedFilters(): Promise<void> {
    await this.page.getByTestId('dept-filter-toggle').click();
  }

  async filter(kind: 'status' | 'manager' | 'type', value: string): Promise<void> {
    await this.page.getByTestId(`dept-filter-${kind}`).selectOption(value);
  }

  async clearFilters(): Promise<void> {
    await this.page.getByTestId('dept-filter-clear').click();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('dept-empty').isVisible().catch(() => false);
  }

  async showTable(): Promise<void> {
    await this.page.getByTestId('dept-view-table').click();
  }

  async showOrgChart(): Promise<void> {
    await this.page.getByTestId('dept-view-org-structure').click();
  }

  async showCards(): Promise<void> {
    await this.page.getByTestId('dept-view-card').click();
  }

  async create(): Promise<void> {
    await this.page.getByTestId('dept-new').click();
  }

  async canCreate(): Promise<boolean> {
    return this.page.getByTestId('dept-new').isVisible().catch(() => false);
  }

  async openDetail(code: string): Promise<void> {
    await this.card(code).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export interface DepartmentInput {
  code?: string;
  name?: string;
  description?: string;
  /** Option VALUE — the parent department's id, or '' for top level. */
  parentId?: string;
  /** Option VALUE — the manager's employee id, or '' for none. */
  managerId?: string;
}

export class DepartmentFormPage {
  constructor(private readonly page: Page) {}

  async openNew(): Promise<void> {
    await open(this.page, '/dashboard/departments/new');
  }

  async openEdit(id: string): Promise<void> {
    await open(this.page, `/dashboard/departments/${id}/edit`);
  }

  async fill(input: DepartmentInput): Promise<void> {
    if (input.code !== undefined) await this.page.getByTestId('dept-code').fill(input.code);
    if (input.name !== undefined) await this.page.getByTestId('dept-name').fill(input.name);
    if (input.description !== undefined) {
      await this.page.getByTestId('dept-description').fill(input.description);
    }
    if (input.parentId !== undefined) {
      await this.page.getByTestId('dept-parent').selectOption(input.parentId);
    }
    if (input.managerId !== undefined) {
      await this.page.getByTestId('dept-manager').selectOption(input.managerId);
    }
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('dept-submit').click();
  }

  /** The banner that carries the server's reason for refusing the save. */
  async errorBanner(): Promise<string | null> {
    const banner = this.page.getByTestId('dept-form-error');
    if (!(await banner.isVisible().catch(() => false))) return null;
    return (await banner.innerText()).trim();
  }

  async parentOptions(): Promise<string[]> {
    return this.page.getByTestId('dept-parent').locator('option').allInnerTexts();
  }

  async managerOptions(): Promise<string[]> {
    return this.page.getByTestId('dept-manager').locator('option').allInnerTexts();
  }

  async hasParentWarning(): Promise<boolean> {
    return this.page.getByTestId('dept-parent-warning').isVisible().catch(() => false);
  }

  async hasManagerWarning(): Promise<boolean> {
    return this.page.getByTestId('dept-manager-warning').isVisible().catch(() => false);
  }
}

export class DepartmentDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/departments/${id}`);
  }

  async name(): Promise<string> {
    return (await this.page.getByTestId('dept-detail-name').innerText()).trim();
  }

  async head(): Promise<string | null> {
    const el = this.page.getByTestId('dept-detail-manager');
    if (!(await el.isVisible().catch(() => false))) return null;
    return (await el.innerText()).trim();
  }

  async tab(name: 'overview' | 'employees' | 'teams' | 'performance' | 'history'): Promise<void> {
    await this.page.getByTestId(`dept-tab-${name}`).click();
  }

  async openActions(): Promise<void> {
    await this.page.getByTestId('dept-detail-actions').click();
  }

  /** Guarded by a native confirm — install a dialog handler first. */
  async delete(): Promise<void> {
    await this.openActions();
    await this.page.getByTestId('dept-detail-delete').click();
  }

  async canEdit(): Promise<boolean> {
    return this.page.getByTestId('dept-detail-edit').isVisible().catch(() => false);
  }
}

export class DepartmentTreePage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/departments/tree');
  }

  node(code: string) {
    return this.page.getByTestId(`tree-node-${code}`);
  }

  async has(code: string): Promise<boolean> {
    return (await this.node(code).count()) > 0;
  }

  /** Nesting depth as the tree itself reports it. */
  async level(code: string): Promise<number> {
    return Number(await this.node(code).getAttribute('data-tree-level'));
  }

  async collapse(code: string): Promise<void> {
    await this.node(code).getByTestId('tree-node-expand').click();
  }
}

// ── Organization: change requests ───────────────────────────────────────────

export class ChangeRequestsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/departments/change-requests');
  }

  card(id: string) {
    return this.page.getByTestId(`cr-card-${id}`);
  }

  async has(id: string): Promise<boolean> {
    return (await this.card(id).count()) > 0;
  }

  async status(id: string): Promise<string> {
    return (await this.card(id).getByTestId('cr-status').innerText()).trim();
  }

  async stat(name: 'all' | 'pending' | 'approved' | 'rejected'): Promise<number> {
    return Number((await this.page.getByTestId(`cr-stat-${name}`).innerText()).trim());
  }

  async filter(status: 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'): Promise<void> {
    await this.page.getByTestId(`cr-filter-${status}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('cr-empty').isVisible().catch(() => false);
  }

  async hasError(): Promise<boolean> {
    return this.page.getByTestId('cr-error').isVisible().catch(() => false);
  }

  async openDetail(id: string): Promise<void> {
    await this.card(id).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class ChangeRequestDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/departments/change-requests/${id}`);
  }

  async status(): Promise<string> {
    return (await this.page.getByTestId('cr-detail-status').innerText()).trim();
  }

  async impact(): Promise<{
    employees: number;
    teams: number;
    leaves: number;
    overtime: number;
    days: string;
  }> {
    const num = async (testId: string) =>
      Number((await this.page.getByTestId(testId).innerText()).trim());
    return {
      employees: await num('cr-impact-employees'),
      teams: await num('cr-impact-teams'),
      leaves: await num('cr-impact-leaves'),
      overtime: await num('cr-impact-overtime'),
      days: (await this.page.getByTestId('cr-impact-days').innerText()).trim(),
    };
  }

  async canReview(): Promise<boolean> {
    return this.page.getByTestId('cr-approve').isVisible().catch(() => false);
  }

  /** Ends with a native alert and a redirect back to the list. */
  async approve(note?: string): Promise<void> {
    await this.decide('cr-approve', note);
  }

  async reject(note?: string): Promise<void> {
    await this.decide('cr-reject', note);
  }

  private async decide(button: string, note?: string): Promise<void> {
    await this.page.getByTestId(button).click();
    if (note !== undefined) await this.page.getByTestId('cr-review-note').fill(note);
    await this.page.getByTestId('cr-review-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async reviewNote(): Promise<string | null> {
    const el = this.page.getByTestId('cr-review-note-text');
    if (!(await el.isVisible().catch(() => false))) return null;
    return (await el.innerText()).trim();
  }

  async reviewer(): Promise<string | null> {
    const el = this.page.getByTestId('cr-reviewer');
    if (!(await el.isVisible().catch(() => false))) return null;
    return (await el.innerText()).trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// People module (Phase 2)
//
// Same rules as the Organization block above: thin wrappers, selectors only,
// no assertions. Two conventions worth stating because People differs slightly
// from Organization:
//
//   Rows are keyed by the NATURAL key a spec knows before it navigates —
//   employeeCode, team code, contract number, visa document number — never the
//   uuid the server minted. A spec that seeds `E2E-CON1` can address that row
//   without first reading it back.
//
//   Termination rows are the exception: a termination request has no natural
//   key, so those are keyed by id, which the spec gets from the API client that
//   created them.
// ─────────────────────────────────────────────────────────────────────────────

export class EmployeeDirectoryPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/employees');
  }

  row(employeeCode: string) {
    return this.page.getByTestId(`emp-row-${employeeCode}`);
  }

  card(employeeCode: string) {
    return this.page.getByTestId(`emp-card-${employeeCode}`);
  }

  async search(term: string): Promise<void> {
    // The input debounces at 300ms and then refetches, so a fixed wait races
    // the response on a slow run. Waiting for the request the debounce fires
    // makes it deterministic; the timeout fallback keeps a search that matches
    // the current query (and therefore issues nothing) from hanging.
    const settled = this.page
      .waitForResponse(
        (r) => r.url().includes('/employees') && r.request().method() === 'GET',
        { timeout: 8000 },
      )
      .catch(() => undefined);
    await this.page.getByTestId('emp-search').fill(term);
    await settled;
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async clearSearch(): Promise<void> {
    const x = this.page.getByTestId('emp-search-clear');
    if (await x.isVisible().catch(() => false)) await x.click();
    await this.page.waitForTimeout(450);
  }

  async switchView(view: 'table' | 'card' | 'kanban'): Promise<void> {
    await this.page.getByTestId(`emp-view-${view}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    // Each view refetches, and the card/kanban grids animate in. Without
    // waiting for a row to exist the next assertion races the render — which
    // is what made EMP-UI-01 flaky on its first run.
    await this.page
      .locator('[data-testid^="emp-row-"], [data-testid^="emp-card-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(() => {});
  }

  async stat(key: 'total' | 'active' | 'onLeave' | 'terminated' | 'departments'): Promise<number> {
    const raw = await this.page.getByTestId(`emp-stat-${key}-value`).innerText();
    return Number(raw.trim());
  }

  /** The "N of M" line. Only rendered when there is more than one page. */
  async countText(): Promise<string | null> {
    const el = this.page.getByTestId('emp-count');
    if (!(await el.isVisible().catch(() => false))) return null;
    return (await el.innerText()).trim();
  }

  async openFilters(): Promise<void> {
    await this.page.getByTestId('emp-filter-open').click();
  }

  /**
   * The real <input type="checkbox"> carries `class="sr-only"`, so it sits
   * outside the viewport and neither `.check()` nor `.check({force:true})`
   * can reach it. The control a person actually clicks is the enclosing
   * <label>, which is what this clicks — the same event the app receives from
   * a real user.
   */
  private async toggleFilter(testId: string): Promise<void> {
    await this.page
      .getByTestId(testId)
      .locator('xpath=ancestor::label[1]')
      .click();
  }

  async filterByStatus(status: string): Promise<void> {
    await this.toggleFilter(`emp-filter-status-${status}`);
  }

  async filterByDepartment(codeOrId: string): Promise<void> {
    await this.toggleFilter(`emp-filter-dept-${codeOrId}`);
  }

  async applyFilters(): Promise<void> {
    await this.page.getByTestId('emp-filter-apply').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async clearFilters(): Promise<void> {
    const inline = this.page.getByTestId('emp-filter-clear');
    if (await inline.isVisible().catch(() => false)) {
      await inline.click();
    } else {
      await this.openFilters();
      await this.page.getByTestId('emp-filter-reset').click();
      await this.applyFilters();
    }
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('emp-empty').isVisible().catch(() => false);
  }

  /** Export carries no permission gate today — see finding P3. */
  async canExport(): Promise<boolean> {
    return this.page.getByTestId('emp-export-open').isVisible().catch(() => false);
  }

  async canImport(): Promise<boolean> {
    return this.page.getByTestId('employees-import-open').isVisible().catch(() => false);
  }

  async canCreate(): Promise<boolean> {
    return this.page.getByTestId('emp-new').isVisible().catch(() => false);
  }

  async gotoPage(n: number): Promise<void> {
    await this.page.getByTestId(`emp-page-${n}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class EmployeeDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string, section?: string): Promise<void> {
    await open(this.page, `/dashboard/employees/${id}${section ? `?section=${section}` : ''}`);
  }

  async name(): Promise<string> {
    return (await this.page.getByTestId('emp-detail-name').innerText()).trim();
  }

  async code(): Promise<string> {
    return (await this.page.getByTestId('emp-detail-code').innerText()).trim();
  }

  async status(): Promise<string> {
    return (await this.page.getByTestId('emp-detail-status').innerText()).trim();
  }

  async department(): Promise<string> {
    return (await this.page.getByTestId('emp-detail-department').innerText()).trim();
  }

  async openSection(
    section: 'profile' | 'documents' | 'visa' | 'supervisor' | 'salary' | 'rewards' | 'activity',
  ): Promise<void> {
    await this.page.getByTestId(`emp-section-${section}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The salary section is ADMIN/HR only — absence is the assertion for MANAGER. */
  async hasSection(section: string): Promise<boolean> {
    return this.page.getByTestId(`emp-section-${section}`).isVisible().catch(() => false);
  }

  async openActions(): Promise<void> {
    await this.page.getByTestId('emp-detail-actions').click();
  }

  async canDelete(): Promise<boolean> {
    await this.openActions();
    return this.page.getByTestId('emp-detail-delete').isVisible().catch(() => false);
  }

  /** Offered only when `allow_hard_delete_terminated` is on AND status is TERMINATED. */
  async canHardDelete(): Promise<boolean> {
    await this.openActions();
    return this.page.getByTestId('emp-detail-hard-delete').isVisible().catch(() => false);
  }

  async delete(): Promise<void> {
    await this.openActions();
    await this.page.getByTestId('emp-detail-delete').click();
  }

  async hardDelete(): Promise<void> {
    await this.openActions();
    await this.page.getByTestId('emp-detail-hard-delete').click();
  }

  async edit(): Promise<void> {
    await this.page.getByTestId('emp-detail-edit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class EmployeeFormPage {
  constructor(private readonly page: Page) {}

  async openEdit(id: string): Promise<void> {
    await open(this.page, `/dashboard/employees/${id}/edit`);
  }

  /**
   * Steps 1-2 of the form are rendered from the active profile template, so
   * every field is addressed by its template fieldKey via `field-{key}` —
   * the id `components/dynamic-form/Field.tsx` already emits.
   */
  field(fieldKey: string) {
    return this.page.getByTestId(`field-${fieldKey}`);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('emp-form-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async cancel(): Promise<void> {
    await this.page.getByTestId('emp-form-cancel').click();
  }
}

export class OnboardingWizardPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/employees/new');
  }

  field(fieldKey: string) {
    return this.page.getByTestId(`field-${fieldKey}`);
  }

  async next(): Promise<void> {
    await this.page.getByTestId('onboard-next').click();
  }

  /** True while the wizard is refusing to advance — i.e. a step failed validation. */
  async isBlocked(): Promise<boolean> {
    return !(await this.page.getByTestId('onboard-next').isEnabled().catch(() => false));
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('onboard-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class TeamsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/teams');
  }

  row(code: string) {
    return this.page.getByTestId(`team-row-${code}`);
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('team-search').fill(term);
  }

  async create(): Promise<void> {
    await this.page.getByTestId('team-create').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('team-empty').isVisible().catch(() => false);
  }

  async openTeam(code: string): Promise<void> {
    await this.row(code).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class TeamFormPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/teams/new');
  }

  async fill(v: {
    name?: string;
    code?: string;
    departmentId?: string;
    type?: string;
    leadId?: string;
  }): Promise<void> {
    if (v.name !== undefined) await this.page.getByTestId('team-form-name').fill(v.name);
    if (v.code !== undefined) await this.page.getByTestId('team-form-code').fill(v.code);
    if (v.departmentId !== undefined)
      await this.page.getByTestId('team-form-department').selectOption(v.departmentId);
    if (v.type !== undefined) await this.page.getByTestId('team-form-type').selectOption(v.type);
    if (v.leadId !== undefined) await this.page.getByTestId('team-form-lead').selectOption(v.leadId);
  }

  /**
   * This form reports BOTH validation and server refusals through `alert()`,
   * so a spec has to have `captureNativeDialogs` installed before calling this
   * or the message is lost. See finding P16.
   */
  async submit(): Promise<void> {
    await this.page.getByTestId('team-form-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class TeamDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/teams/${id}`);
  }

  async name(): Promise<string> {
    return (await this.page.getByTestId('team-detail-name').innerText()).trim();
  }

  async openAddMember(): Promise<void> {
    await this.page.getByTestId('team-member-add').click();
  }

  async confirmAddMember(): Promise<void> {
    await this.page.getByTestId('team-member-add-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Removal goes through a native `confirm()` — install a dialog handler first. */
  async removeMember(employeeCode: string): Promise<void> {
    await this.page.getByTestId(`team-member-remove-${employeeCode}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class SupervisorTeamsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/supervisor-teams');
  }

  row(id: string) {
    return this.page.getByTestId(`steam-row-${id}`);
  }

  async create(): Promise<void> {
    await this.page.getByTestId('steam-create').click();
  }

  async fillName(name: string): Promise<void> {
    await this.page.getByTestId('steam-form-name').fill(name);
  }

  /** Required: `save()` refuses with a toast until a supervisor is chosen. */
  async chooseSupervisor(employeeId: string): Promise<void> {
    await this.page
      .getByTestId('steam-form-supervisor')
      .selectOption(employeeId);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('steam-form-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async remove(id: string): Promise<void> {
    await this.page.getByTestId(`steam-delete-${id}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('steam-empty').isVisible().catch(() => false);
  }
}

export class ContractsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/contracts');
  }

  row(contractNumber: string) {
    return this.page.getByTestId(`con-row-${contractNumber}`);
  }

  async status(contractNumber: string): Promise<string> {
    return (await this.page.getByTestId(`con-status-${contractNumber}`).innerText()).trim();
  }

  async search(term: string): Promise<void> {
    // Debounced then refetched — same race as the employee directory, so the
    // same fix: wait for the request the debounce fires rather than for a
    // fixed interval.
    const settled = this.page
      .waitForResponse(
        (r) => r.url().includes('/contracts') && r.request().method() === 'GET',
        { timeout: 8000 },
      )
      .catch(() => undefined);
    await this.page.getByTestId('con-search').fill(term);
    await settled;
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('con-empty').isVisible().catch(() => false);
  }

  async canCreate(): Promise<boolean> {
    return this.page.getByTestId('con-create').isVisible().catch(() => false);
  }

  async create(): Promise<void> {
    await this.page.getByTestId('con-create').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async gotoTerminations(): Promise<void> {
    await this.page.getByTestId('con-terminations-link').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class ContractFormPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/contracts/new');
  }

  /**
   * The employee picker is an autocomplete, not a select: type, then click the
   * option. It posts the selected id, never the typed text — which is exactly
   * what the component test asserts.
   */
  async chooseEmployee(search: string, employeeCode: string): Promise<void> {
    // The option list only exists while the dropdown is open, and the dropdown
    // opens on focus or on typing — so the search box has to be driven first.
    await this.page.getByTestId('con-form-employee-search').fill(search);
    await this.page
      .getByTestId(`con-form-employee-option-${employeeCode}`)
      .click();
  }

  async fill(v: {
    type?: string;
    workType?: string;
    hours?: string;
    start?: string;
    end?: string;
    salary?: string;
  }): Promise<void> {
    if (v.type !== undefined) await this.page.getByTestId('con-form-type').selectOption(v.type);
    if (v.workType !== undefined)
      await this.page.getByTestId('con-form-worktype').selectOption(v.workType);
    if (v.hours !== undefined) await this.page.getByTestId('con-form-hours').fill(v.hours);
    if (v.start !== undefined) await this.page.getByTestId('con-form-start').fill(v.start);
    if (v.end !== undefined) await this.page.getByTestId('con-form-end').fill(v.end);
    if (v.salary !== undefined) await this.page.getByTestId('con-form-salary').fill(v.salary);
  }

  /** `endDate` is only rendered when the type is not INDEFINITE. */
  async hasEndDate(): Promise<boolean> {
    return this.page.getByTestId('con-form-end').isVisible().catch(() => false);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('con-form-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class ContractDetailPage {
  constructor(private readonly page: Page) {}

  async open(id: string): Promise<void> {
    await open(this.page, `/dashboard/contracts/${id}`);
  }

  async openTerminationRequest(): Promise<void> {
    await this.page.getByTestId('con-termreq-open').click();
  }

  async fillTerminationRequest(v: {
    category?: string;
    noticeDate?: string;
    terminationDate?: string;
    reason?: string;
  }): Promise<void> {
    if (v.category !== undefined)
      await this.page.getByTestId('con-termreq-category').selectOption(v.category);
    if (v.noticeDate !== undefined)
      await this.page.getByTestId('con-termreq-notice').fill(v.noticeDate);
    if (v.terminationDate !== undefined)
      await this.page.getByTestId('con-termreq-date').fill(v.terminationDate);
    if (v.reason !== undefined) await this.page.getByTestId('con-termreq-reason').fill(v.reason);
  }

  async submitTerminationRequest(): Promise<void> {
    await this.page.getByTestId('con-termreq-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class TerminationsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/contracts/terminations');
  }

  /**
   * This screen denies with an in-place panel instead of redirecting to /403 —
   * the only one in the app that does. Finding P4.
   */
  async isDenied(): Promise<boolean> {
    return this.page.getByTestId('term-noaccess').isVisible().catch(() => false);
  }

  row(id: string) {
    return this.page.getByTestId(`term-row-${id}`);
  }

  async stat(key: 'pending' | 'urgent' | 'approved'): Promise<number> {
    return Number((await this.page.getByTestId(`term-stat-${key}`).innerText()).trim());
  }

  async openTab(tab: 'pending' | 'history'): Promise<void> {
    await this.page.getByTestId(`term-tab-${tab}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async showUrgentOnly(on: boolean): Promise<void> {
    await this.page.getByTestId(on ? 'term-urgent-filter' : 'term-filter-all').click();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('term-empty').isVisible().catch(() => false);
  }

  /** The server refuses approval while the employee still holds assets. */
  async hasClearanceBanner(id: string): Promise<boolean> {
    return this.page
      .getByTestId(`term-clearance-banner-${id}`)
      .isVisible()
      .catch(() => false);
  }

  async canDecide(id: string): Promise<boolean> {
    return this.page.getByTestId(`term-approve-${id}`).isVisible().catch(() => false);
  }

  async approve(id: string): Promise<void> {
    await this.page.getByTestId(`term-approve-${id}`).click();
    await this.page.getByTestId('term-approve-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** The reason is required: the confirm button stays disabled while it is blank. */
  async reject(id: string, reason: string): Promise<void> {
    await this.page.getByTestId(`term-reject-${id}`).click();
    await this.page.getByTestId('term-reject-reason').fill(reason);
    await this.page.getByTestId('term-reject-confirm').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async rejectConfirmEnabled(id: string): Promise<boolean> {
    await this.page.getByTestId(`term-reject-${id}`).click();
    return this.page.getByTestId('term-reject-confirm').isEnabled().catch(() => false);
  }
}

export class VisaReportsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/visa-reports');
  }

  row(documentNumber: string) {
    return this.page.getByTestId(`visa-report-row-${documentNumber}`);
  }

  async summary(key: 'active' | 'expiring' | 'expired' | 'renewed'): Promise<string> {
    return (await this.page.getByTestId(`visa-summary-${key}`).innerText()).trim();
  }

  async search(term: string): Promise<void> {
    const settled = this.page
      .waitForResponse(
        (r) =>
          r.url().includes('/legal-documents') &&
          r.request().method() === 'GET',
        { timeout: 8000 },
      )
      .catch(() => undefined);
    await this.page.getByTestId('visa-search').fill(term);
    await settled;
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async filter(v: { status?: string; type?: string; expiringInDays?: string }): Promise<void> {
    if (v.status !== undefined)
      await this.page.getByTestId('visa-filter-status').selectOption(v.status);
    if (v.type !== undefined) await this.page.getByTestId('visa-filter-type').selectOption(v.type);
    if (v.expiringInDays !== undefined)
      await this.page.getByTestId('visa-filter-expiring').selectOption(v.expiringInDays);
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('visa-empty').isVisible().catch(() => false);
  }

  /** Builds the XLSX in-browser by looping every page — see finding P6. */
  async export(): Promise<void> {
    await this.page.getByTestId('visa-export').click();
  }

  /** A row click deep-links into the employee's Visa tab. */
  async openEmployeeVisa(documentNumber: string): Promise<void> {
    await this.row(documentNumber).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

/** The per-employee visa CRUD that the reports screen only reads. */
export class EmployeeVisaSection {
  constructor(private readonly page: Page) {}

  row(documentNumber: string) {
    return this.page.getByTestId(`visa-row-${documentNumber}`);
  }

  async status(documentNumber: string): Promise<string> {
    return (await this.page.getByTestId(`visa-status-${documentNumber}`).innerText()).trim();
  }

  async add(): Promise<void> {
    await this.page.getByTestId('visa-add').click();
  }

  async fill(v: {
    number?: string;
    type?: string;
    country?: string;
    issueDate?: string;
    expiryDate?: string;
  }): Promise<void> {
    if (v.number !== undefined) await this.page.getByTestId('visa-form-number').fill(v.number);
    if (v.type !== undefined) await this.page.getByTestId('visa-form-type').selectOption(v.type);
    if (v.country !== undefined) await this.page.getByTestId('visa-form-country').fill(v.country);
    if (v.issueDate !== undefined)
      await this.page.getByTestId('visa-form-issue').fill(v.issueDate);
    if (v.expiryDate !== undefined)
      await this.page.getByTestId('visa-form-expiry').fill(v.expiryDate);
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('visa-form-submit').click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  /** Renew is offered only on the current record; cancel only on a live one. */
  async canRenew(documentNumber: string): Promise<boolean> {
    return this.page.getByTestId(`visa-renew-${documentNumber}`).isVisible().catch(() => false);
  }

  async renew(documentNumber: string): Promise<void> {
    await this.page.getByTestId(`visa-renew-${documentNumber}`).click();
  }

  async cancel(documentNumber: string): Promise<void> {
    await this.page.getByTestId(`visa-cancel-${documentNumber}`).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('visa-empty').isVisible().catch(() => false);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Time & Attendance (Phase 3)
 *
 * These sit alongside the three that already existed — `MyAttendancePage`,
 * `AttendanceClockPage` and `AttendanceCorrectionsPage` — which are EXTENDED
 * rather than replaced, because `attendance.spec.ts` and
 * `attendance-correction.spec.ts` depend on their current surfaces.
 *
 * Every reader below returns a machine-readable attribute rather than rendered
 * text. Each of these screens interpolates its numbers into translated
 * sentences ("Showing 12 of 40"), and the log grid's cell state is DERIVED by
 * merging holiday, weekend, future and record status — so the label is not the
 * value, and `data-*` is the only honest assertion surface.
 * ──────────────────────────────────────────────────────────────────────────── */

type AttendancePeriod = 'today' | 'week' | 'month' | 'custom';

export class AttendanceOverviewPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance');
  }

  async period(p: AttendancePeriod): Promise<void> {
    await this.page.getByTestId(`att-period-${p}`).click();
  }

  async activePeriod(): Promise<string | null> {
    for (const p of ['today', 'week', 'month', 'custom']) {
      const el = this.page.getByTestId(`att-period-${p}`);
      if ((await el.getAttribute('data-active')) === 'true') return p;
    }
    return null;
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('att-search').fill(term);
  }

  async stat(key: 'total' | 'present' | 'late' | 'absent'): Promise<number> {
    const raw = await this.page.getByTestId(`att-stat-${key}`).getAttribute('data-value');
    return Number(raw ?? NaN);
  }

  /** `{ shown, total }` from the filter panel's counter. */
  async resultCount(): Promise<{ shown: number; total: number }> {
    const el = this.page.getByTestId('att-count');
    return {
      shown: Number(await el.getAttribute('data-shown')),
      total: Number(await el.getAttribute('data-total')),
    };
  }

  rows() {
    return this.page.getByTestId('att-row');
  }

  async rowCount(): Promise<number> {
    return this.rows().count();
  }

  async employeeIds(): Promise<string[]> {
    return this.rows().evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-employee-id')).filter(Boolean) as string[],
    );
  }

  async attendanceIds(): Promise<string[]> {
    return this.rows().evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-attendance-id')).filter(Boolean) as string[],
    );
  }

  async rowStatus(employeeId: string): Promise<string | null> {
    return this.page
      .locator(`[data-testid="att-row"][data-employee-id="${employeeId}"]`)
      .getAttribute('data-status');
  }

  async chip(status: string): Promise<void> {
    await this.page.getByTestId(`att-chip-${status}`).click();
  }

  async canClearFilters(): Promise<boolean> {
    return this.page.getByTestId('att-clear').isVisible().catch(() => false);
  }

  async clearFilters(): Promise<void> {
    await this.page.getByTestId('att-clear').click();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('att-empty').isVisible().catch(() => false);
  }

  /** Sorts, and reports the order the header now advertises. */
  async sortBy(col: 'name' | 'checkIn' | 'status'): Promise<string | null> {
    await this.page.getByTestId(`att-sort-${col}`).click();
    return this.page.getByTestId(`att-sort-${col}`).getAttribute('data-order');
  }

  async openRow(attendanceId: string): Promise<void> {
    await this.page.getByTestId(`att-row-view-${attendanceId}`).click();
  }

  async navTo(where: 'history' | 'corrections' | 'reports'): Promise<void> {
    await this.page.getByTestId(`att-nav-${where}`).click();
  }
}

export class AttendanceLogsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance/history');
  }

  async month(): Promise<{ month: number; year: number }> {
    const el = this.page.getByTestId('attlog-month');
    return {
      month: Number(await el.getAttribute('data-month')),
      year: Number(await el.getAttribute('data-year')),
    };
  }

  async prevMonth(): Promise<void> {
    await this.page.getByTestId('attlog-prev-month').click();
  }

  async nextMonth(): Promise<void> {
    await this.page.getByTestId('attlog-next-month').click();
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('attlog-search').fill(term);
  }

  async hasRow(employeeId: string): Promise<boolean> {
    return this.page
      .getByTestId(`attlog-row-${employeeId}`)
      .isVisible()
      .catch(() => false);
  }

  /** The DERIVED cell state — holiday and weekend override the stored status. */
  async cell(employeeId: string, day: number): Promise<string | null> {
    return this.page
      .getByTestId(`attlog-cell-${employeeId}-${day}`)
      .getAttribute('data-cell-status');
  }

  async cellSessions(employeeId: string, day: number): Promise<number> {
    const raw = await this.page
      .getByTestId(`attlog-cell-${employeeId}-${day}`)
      .getAttribute('data-sessions');
    return Number(raw ?? 0);
  }

  async cellIsWeekend(employeeId: string, day: number): Promise<boolean> {
    return (
      (await this.page
        .getByTestId(`attlog-cell-${employeeId}-${day}`)
        .getAttribute('data-weekend')) === 'true'
    );
  }

  async openSessions(employeeId: string, day: number): Promise<void> {
    await this.page.getByTestId(`attlog-cell-${employeeId}-${day}`).click();
  }

  async sessionsInModal(): Promise<number> {
    const raw = await this.page.getByTestId('attlog-sessions-modal').getAttribute('data-count');
    return Number(raw ?? 0);
  }

  async closeSessions(): Promise<void> {
    await this.page.getByTestId('attlog-sessions-close').click();
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('attlog-empty').isVisible().catch(() => false);
  }
}

export class AttendanceReportsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance/reports');
  }

  async kpi(key: 'checkins' | 'lateRate' | 'earlyRate' | 'avgHours'): Promise<number> {
    const raw = await this.page.getByTestId(`attrep-kpi-${key}`).getAttribute('data-value');
    return Number(raw ?? NaN);
  }

  async prevMonth(): Promise<void> {
    await this.page.getByTestId('attrep-prev-month').click();
  }

  /** The role-gated summary table — a MANAGER gets the KPI cards and not this. */
  async hasSummaryTable(): Promise<boolean> {
    return this.page.getByTestId('attrep-summary').isVisible().catch(() => false);
  }

  async standing(employeeId: string): Promise<string | null> {
    return this.page.getByTestId(`attrep-row-${employeeId}`).getAttribute('data-standing');
  }

  async rowCount(): Promise<number> {
    return this.page.locator('[data-testid^="attrep-row-"]').count();
  }
}

export class AttendanceManagerPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance/management');
  }

  async bannerVisible(): Promise<boolean> {
    return this.page.getByTestId('attman-banner').isVisible().catch(() => false);
  }

  async openAutoAbsent(): Promise<void> {
    await this.page.getByTestId('absent-open').click();
  }

  async confirmAutoAbsent(): Promise<void> {
    await this.page.getByTestId('absent-confirm').click();
  }

  async cancelAutoAbsent(): Promise<void> {
    await this.page.getByTestId('absent-cancel').click();
  }

  async autoAbsentMarked(): Promise<number | null> {
    const el = this.page.getByTestId('absent-result');
    if (!(await el.isVisible().catch(() => false))) return null;
    return Number(await el.getAttribute('data-marked'));
  }

  async pickEmployee(term: string, employeeId: string): Promise<void> {
    await this.page.getByTestId('manual-employee-search').fill(term);
    await this.page.getByTestId(`manual-employee-option-${employeeId}`).click();
  }

  async fillManual(v: {
    date?: string;
    status?: string;
    checkIn?: string;
    checkOut?: string;
    notes?: string;
  }): Promise<void> {
    if (v.date) await this.page.getByTestId('manual-date').fill(v.date);
    if (v.status) await this.page.getByTestId('manual-status').selectOption(v.status);
    if (v.checkIn) await this.page.getByTestId('manual-in').fill(v.checkIn);
    if (v.checkOut) await this.page.getByTestId('manual-out').fill(v.checkOut);
    if (v.notes) await this.page.getByTestId('manual-notes').fill(v.notes);
  }

  async submitManual(): Promise<void> {
    await this.page.getByTestId('manual-submit').click();
  }

  async manualSubmitEnabled(): Promise<boolean> {
    return this.page.getByTestId('manual-submit').isEnabled();
  }

  async manualError(): Promise<string | null> {
    const el = this.page.getByTestId('manual-error');
    return (await el.isVisible().catch(() => false)) ? el.textContent() : null;
  }

  async manualSuccess(): Promise<string | null> {
    const el = this.page.getByTestId('manual-success');
    return (await el.isVisible().catch(() => false)) ? el.textContent() : null;
  }
}

export class BiometricEnrollmentPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/attendance/face-management');
  }

  async stat(key: 'total' | 'registered' | 'unregistered'): Promise<number> {
    const raw = await this.page.getByTestId(`bio-stat-${key}`).getAttribute('data-value');
    return Number(raw ?? NaN);
  }

  async search(term: string): Promise<void> {
    await this.page.getByTestId('bio-search').fill(term);
  }

  async isEnrolled(code: string): Promise<boolean> {
    return (
      (await this.page.getByTestId(`bio-row-${code}`).getAttribute('data-enrolled')) === 'true'
    );
  }

  async faceCount(code: string): Promise<number> {
    const raw = await this.page.getByTestId(`bio-row-${code}`).getAttribute('data-face-count');
    return Number(raw ?? 0);
  }

  async openEmployee(code: string): Promise<void> {
    await this.page.getByTestId(`bio-open-${code}`).click();
  }

  async back(): Promise<void> {
    await this.page.getByTestId('bio-back').click();
  }

  async rowCount(): Promise<number> {
    return this.page.locator('[data-testid^="bio-row-"]').count();
  }
}

/** `FaceRegistration` — mounted by BOTH the admin screen and self-service. */
export class FaceEnrollmentPanel {
  constructor(private readonly page: Page) {}

  async count(): Promise<number> {
    const raw = await this.page.getByTestId('facereg-panel').getAttribute('data-count');
    return Number(raw ?? 0);
  }

  async max(): Promise<number> {
    const raw = await this.page.getByTestId('facereg-panel').getAttribute('data-max');
    return Number(raw ?? 0);
  }

  async descriptorIds(): Promise<string[]> {
    return this.page
      .locator('[data-testid^="facereg-item-"]')
      .evaluateAll((els) =>
        els
          .map((e) => (e.getAttribute('data-testid') ?? '').replace('facereg-item-', ''))
          .filter(Boolean),
      );
  }

  /** Guarded by a native `confirm()` — install `captureNativeDialogs` first. */
  async deleteDescriptor(id: string): Promise<void> {
    await this.page.getByTestId(`facereg-delete-${id}`).click();
  }

  async limitReached(): Promise<boolean> {
    return this.page.getByTestId('facereg-limit').isVisible().catch(() => false);
  }

  async message(): Promise<{ kind: string | null; text: string } | null> {
    const el = this.page.getByTestId('facereg-message');
    if (!(await el.isVisible().catch(() => false))) return null;
    return { kind: await el.getAttribute('data-kind'), text: (await el.textContent()) ?? '' };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Leave & Overtime — screens that had no page object at all.
 *
 * `/dashboard/leaves`, `/leaves/pending`, `/leaves/balances`, `/my-overtime`
 * and `/my-department/team-balances` carried ZERO testids before this phase, so
 * nothing could drive them. Every reader below goes through a `data-*`
 * attribute rather than the rendered text: the labels are next-intl and exist
 * in English and Arabic, so a text selector encodes the language rather than
 * the intent.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The approval-chain panel, which is the same component shape on both detail
 * screens — `prefix` is 'leave' or 'ot'.
 */
export class ApprovalTrailPanel {
  constructor(
    private readonly page: Page,
    private readonly prefix: 'leave' | 'ot',
  ) {}

  private root() {
    return this.page.getByTestId(`${this.prefix}-trail`);
  }

  async isPresent(): Promise<boolean> {
    return (await this.root().count()) > 0;
  }

  async engaged(): Promise<boolean> {
    if (!(await this.isPresent())) return false;
    return (await this.root().getAttribute('data-engaged')) === 'true';
  }

  async canAct(): Promise<boolean> {
    if (!(await this.isPresent())) return false;
    return (await this.root().getAttribute('data-can-act')) === 'true';
  }

  async activeStep(): Promise<number | null> {
    if (!(await this.isPresent())) return null;
    const v = await this.root().getAttribute('data-active-step');
    return v ? Number(v) : null;
  }

  async steps(): Promise<Array<{ order: number; approverType: string; status: string }>> {
    return this.page.getByTestId(`${this.prefix}-trail-step`).evaluateAll((els) =>
      els.map((e) => ({
        order: Number(e.getAttribute('data-step-order') ?? 0),
        approverType: e.getAttribute('data-approver-type') ?? '',
        status: e.getAttribute('data-step-status') ?? '',
      })),
    );
  }

  /** "Waiting on step N. You are not the approver for this step." */
  async waitingNotice(): Promise<boolean> {
    return this.page
      .getByTestId(`${this.prefix}-trail-waiting`)
      .isVisible()
      .catch(() => false);
  }
}

/**
 * The app's own toast container (`lib/toast.tsx`).
 *
 * `/dashboard/approvals` uses `sonner` instead, so this reads that library's
 * own `[data-sonner-toast]` attribute as a fallback. Do NOT unify the two
 * inside a test phase — the point here is to observe what ships.
 */
export class ToastArea {
  constructor(private readonly page: Page) {}

  async latest(): Promise<{ type: string; text: string } | null> {
    const own = this.page.getByTestId('toast');
    if (await own.count()) {
      const el = own.last();
      return {
        type: (await el.getAttribute('data-toast-type')) ?? '',
        text: await el.innerText(),
      };
    }
    const sonner = this.page.locator('[data-sonner-toast]');
    if (await sonner.count()) {
      const el = sonner.last();
      return {
        type: (await el.getAttribute('data-type')) ?? '',
        text: await el.innerText(),
      };
    }
    return null;
  }

  /** Waits for a toast of `type`, optionally matching `re`, and returns its text. */
  async waitFor(
    type: 'success' | 'error' | 'warning' | 'info',
    re?: RegExp,
  ): Promise<string> {
    const el = this.page.locator(`[data-testid="toast"][data-toast-type="${type}"]`);
    await el.first().waitFor({ state: 'visible', timeout: 15_000 });
    const text = await el.first().innerText();
    if (re && !re.test(text)) {
      throw new Error(`toast matched type "${type}" but not ${re}: ${text}`);
    }
    return text;
  }

  async none(): Promise<boolean> {
    return (await this.page.getByTestId('toast').count()) === 0;
  }

  async dismissAll(): Promise<void> {
    const buttons = this.page.getByTestId('toast-dismiss');
    for (let i = (await buttons.count()) - 1; i >= 0; i--) {
      await buttons.nth(i).click().catch(() => undefined);
    }
  }
}

/** `/dashboard/leaves` — the all-leaves list. */
export class LeavesListPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/leaves');
  }

  private row(id: string) {
    return this.page.locator(`[data-testid="lv-row"][data-leave-id="${id}"]`);
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('lv-row').count();
  }

  async rowIds(): Promise<string[]> {
    return this.page
      .getByTestId('lv-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-leave-id') ?? ''));
  }

  async hasRow(id: string): Promise<boolean> {
    return (await this.row(id).count()) > 0;
  }

  async rowStatus(id: string): Promise<string | null> {
    return this.row(id).getAttribute('data-status');
  }

  async rowType(id: string): Promise<string | null> {
    return this.row(id).getAttribute('data-leave-type');
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('lv-empty').isVisible().catch(() => false);
  }

  /** The search box exists for ADMIN and HR only — its absence is a finding. */
  async hasSearch(): Promise<boolean> {
    return (await this.page.getByTestId('lv-search').count()) > 0;
  }

  async search(text: string): Promise<void> {
    await this.page.getByTestId('lv-search').fill(text);
  }

  async filterStatus(v: '' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'): Promise<void> {
    await this.page.getByTestId('lv-filter-status').selectOption(v);
  }

  async filterType(label: string): Promise<void> {
    await this.page.getByTestId('lv-filter-type').selectOption({ label });
  }

  async filterRange(from: string, to: string): Promise<void> {
    await this.page.getByTestId('lv-filter-from').fill(from);
    await this.page.getByTestId('lv-filter-to').fill(to);
  }

  async hasClear(): Promise<boolean> {
    return (await this.page.getByTestId('lv-filter-clear').count()) > 0;
  }

  async clearFilters(): Promise<void> {
    await this.page.getByTestId('lv-filter-clear').click();
  }

  async refresh(): Promise<void> {
    await this.page.getByTestId('lv-refresh').click();
  }

  async pageCount(): Promise<number> {
    return this.page.locator('[data-testid^="lv-pg-page-"]').count();
  }

  async gotoPage(n: number): Promise<void> {
    await this.page.getByTestId(`lv-pg-page-${n}`).click();
  }

  async activePage(): Promise<number | null> {
    const active = this.page.locator('[data-testid^="lv-pg-page-"][data-active="true"]');
    if (!(await active.count())) return null;
    const id = await active.first().getAttribute('data-testid');
    return id ? Number(id.replace('lv-pg-page-', '')) : null;
  }

  async stat(key: 'pending' | 'approved' | 'rejected' | 'employees'): Promise<number> {
    return num(await this.page.getByTestId(`lv-stat-${key}`).getAttribute('data-value'));
  }

  async typeCard(
    leaveType: string,
  ): Promise<{ used: number; remaining: number; allocated: number } | null> {
    const el = this.page.locator(`[data-testid="lv-type-card"][data-leave-type="${leaveType}"]`);
    if (!(await el.count())) return null;
    return {
      used: num(await el.getAttribute('data-used')),
      remaining: num(await el.getAttribute('data-remaining')),
      allocated: num(await el.getAttribute('data-allocated')),
    };
  }

  async canCreate(): Promise<boolean> {
    return (await this.page.getByTestId('lv-new').count()) > 0;
  }

  async openRow(id: string): Promise<void> {
    await this.row(id).click();
  }
}

/** `/dashboard/leaves/pending` — the approval queue. */
export class PendingLeavesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/leaves/pending');
  }

  async headerCount(): Promise<number> {
    return num(await this.page.getByTestId('lvp-count').getAttribute('data-count'));
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('lvp-row').count();
  }

  async rowIds(): Promise<string[]> {
    return this.page
      .getByTestId('lvp-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-leave-id') ?? ''));
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('lvp-empty').isVisible().catch(() => false);
  }

  async attachmentCount(id: string): Promise<number> {
    return num(
      await this.page
        .locator(`[data-testid="lvp-row"][data-leave-id="${id}"]`)
        .getAttribute('data-attachments'),
    );
  }

  /**
   * The stage badge, or null when the column is absent.
   *
   * `leave_approval_hierarchy_enabled` is NOT pinned in the e2e baseline, so
   * whatever a developer last toggled decides whether this column exists.
   * Callers must tolerate null rather than assert the column into being.
   */
  async stageTier(id: string): Promise<number | null> {
    const cell = this.page
      .locator(`[data-testid="lvp-row"][data-leave-id="${id}"]`)
      .getByTestId('lvp-stage');
    if (!(await cell.count())) return null;
    return num(await cell.getAttribute('data-tier'));
  }

  async openRow(id: string): Promise<void> {
    await this.page
      .locator(`[data-testid="lvp-row"][data-leave-id="${id}"]`)
      .getByTestId('lvp-open')
      .click();
  }
}

/** `/dashboard/leaves/balances` — the grid, the edit modal and the two bulk ops. */
export class LeaveBalancesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/leaves/balances');
  }

  async selectYear(year: number): Promise<void> {
    await this.page.getByTestId('lbl-year').selectOption(String(year));
  }

  async selectedYear(): Promise<number> {
    return Number(await this.page.getByTestId('lbl-year').inputValue());
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('lbl-row').count();
  }

  async employeeIds(): Promise<string[]> {
    return this.page
      .getByTestId('lbl-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-employee-id') ?? ''));
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('lbl-empty').isVisible().catch(() => false);
  }

  async hasLegend(): Promise<boolean> {
    return (await this.page.getByTestId('lbl-legend').count()) > 0;
  }

  async cell(
    employeeId: string,
    leaveType: string,
  ): Promise<{ applicable: boolean; remaining: number; total: number; carried: number }> {
    const el = this.page
      .locator(`[data-testid="lbl-row"][data-employee-id="${employeeId}"]`)
      .locator(`[data-testid="lbl-cell"][data-leave-type="${leaveType}"]`);
    return {
      applicable: (await el.getAttribute('data-applicable')) === 'true',
      remaining: num(await el.getAttribute('data-remaining')),
      total: num(await el.getAttribute('data-total')),
      carried: num(await el.getAttribute('data-carried')),
    };
  }

  /** `'total'` for the employee count, or a leave-type label. */
  async stat(key: 'total' | string): Promise<number> {
    if (key === 'total') {
      return num(await this.page.getByTestId('lbl-stat-total').getAttribute('data-value'));
    }
    return num(
      await this.page
        .locator(`[data-testid="lbl-stat-type"][data-leave-type="${key}"]`)
        .getAttribute('data-remaining'),
    );
  }

  async openEdit(employeeId: string): Promise<void> {
    await this.page
      .locator(`[data-testid="lbl-row"][data-employee-id="${employeeId}"]`)
      .getByTestId('lbl-edit')
      .click();
  }

  async editableTypes(): Promise<string[]> {
    return this.page
      .getByTestId('lbl-modal-allocated')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-leave-type') ?? ''));
  }

  async setAllocated(leaveType: string, days: number): Promise<void> {
    await this.page
      .locator(`[data-testid="lbl-modal-allocated"][data-leave-type="${leaveType}"]`)
      .fill(String(days));
  }

  async setCarried(leaveType: string, days: number): Promise<void> {
    await this.page
      .locator(`[data-testid="lbl-modal-carried"][data-leave-type="${leaveType}"]`)
      .fill(String(days));
  }

  async saveEdit(): Promise<void> {
    await this.page.getByTestId('lbl-modal-save').click();
  }

  async cancelEdit(): Promise<void> {
    await this.page.getByTestId('lbl-modal-cancel').click();
  }

  /**
   * COMPANY-WIDE. Both of these mutate every employee, so a spec that calls them
   * has to run last — see the date/ordering note in `e2e/windows.ts`.
   */
  async runAccrual(confirm: boolean): Promise<void> {
    await this.page.getByTestId('lbl-run-accrual').click();
    if (confirm) {
      await this.page.getByTestId('confirm-modal-confirm').click();
    } else {
      await this.page.keyboard.press('Escape');
    }
  }

  async resetToDefaults(confirm: boolean): Promise<void> {
    await this.page.getByTestId('lbl-reset-defaults').click();
    if (confirm) {
      await this.page.getByTestId('confirm-modal-confirm').click();
    } else {
      await this.page.keyboard.press('Escape');
    }
  }

  async refresh(): Promise<void> {
    await this.page.getByTestId('lbl-refresh').click();
  }
}

/** `/dashboard/my-department/team-balances` — MANAGER only, by inline redirect. */
export class TeamBalancesPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-department/team-balances');
  }

  async rowCount(): Promise<number> {
    return this.page.getByTestId('tb-row').count();
  }

  async employeeIds(): Promise<string[]> {
    return this.page
      .getByTestId('tb-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-employee-id') ?? ''));
  }

  async row(employeeId: string): Promise<{
    initialised: boolean;
    annual: number;
    sick: number;
    carried: number;
  }> {
    const el = this.page.locator(`[data-testid="tb-row"][data-employee-id="${employeeId}"]`);
    return {
      initialised: (await el.getAttribute('data-initialised')) === 'true',
      annual: num(await el.getAttribute('data-annual-remaining')),
      sick: num(await el.getAttribute('data-sick-remaining')),
      carried: num(await el.getAttribute('data-carried')),
    };
  }

  async sortBy(field: 'name' | 'annual' | 'sick'): Promise<'asc' | 'desc'> {
    const header = this.page.getByTestId(`tb-sort-${field}`);
    await header.click();
    return ((await header.getAttribute('data-sort-dir')) as 'asc' | 'desc') ?? 'asc';
  }

  async stat(key: 'members' | 'annualUsed' | 'sickUsed' | 'noBalance'): Promise<number> {
    return num(
      await this.page.locator(`[data-testid="tb-stat"][data-key="${key}"]`).getAttribute('data-value'),
    );
  }

  async isEmpty(): Promise<boolean> {
    return this.page.getByTestId('tb-empty').isVisible().catch(() => false);
  }

  async errorText(): Promise<string | null> {
    const el = this.page.getByTestId('tb-error');
    if (!(await el.count())) return null;
    return el.innerText();
  }
}

/**
 * `/dashboard/my-overtime`.
 *
 * Shares the `overtime-row` testid with the admin list on purpose — the two
 * screens never mount together — so `OvertimeListPage` works against both.
 * This class adds only what is unique to the personal view.
 */
export class MyOvertimePage extends OvertimeListPage {
  async open(): Promise<void> {
    await this.openMine();
  }
}

// ── Time & Schedules ────────────────────────────────────────────────────────
//
// Appended after the attendance block. Nothing above is modified — the
// attendance page objects and the three that pre-date them are another
// session's work and 50 browser cases depend on them.
//
// One convention worth stating, because this module needed it and the others
// did not: the schedule screens are a MONTH view with no date input, so a spec
// cannot navigate to its data by typing. `goToMonth` steps the header until it
// reads the month asked for, which is also the only honest way to prove the
// month buttons re-query — a `goto` with a query string would bypass the very
// control under test.

/** The month the baseline seeds its roster into (`seed-e2e-baseline.ts`). */
export const SCHEDULE_MONTH_LABEL = 'May 2026';

export class ScheduleOverviewPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/schedules/overview');
  }

  /** The index route, which used to be a Next 404 (T23). */
  async openIndex(): Promise<void> {
    await open(this.page, '/dashboard/schedules');
  }

  get currentMonth() {
    return this.page.getByTestId('schedule-current-month');
  }
  get nextMonth() {
    return this.page.getByTestId('schedule-next-month');
  }
  get prevMonth() {
    return this.page.getByTestId('schedule-prev-month');
  }
  get search() {
    return this.page.getByTestId('schedule-search');
  }
  get departmentFilter() {
    return this.page.getByTestId('schedule-department-filter');
  }
  get resultCount() {
    return this.page.getByTestId('schedule-result-count');
  }
  get empty() {
    return this.page.getByTestId('schedule-empty');
  }
  get error() {
    return this.page.getByTestId('schedule-error');
  }
  get loading() {
    return this.page.getByTestId('schedule-loading');
  }

  row(employeeCode: string) {
    return this.page.getByTestId(`schedule-employee-row-${employeeCode}`);
  }
  dayHeader(day: number) {
    return this.page.getByTestId(`schedule-day-header-${day}`);
  }
  cell(employeeCode: string, date: string) {
    return this.page.getByTestId(`schedule-cell-${employeeCode}-${date}`);
  }
  stat(key: 'staff' | 'hours' | 'leaves' | 'overtime') {
    return this.page.getByTestId(`schedule-stat-${key}`);
  }

  /**
   * Step the month header until it reads `label`.
   *
   * Bounded at 24 presses so a header that never changes fails as a timeout
   * with a readable message rather than looping until the suite's own limit.
   */
  async goToMonth(label: string, max = 24): Promise<void> {
    for (let i = 0; i < max; i++) {
      const current = (await this.currentMonth.textContent())?.trim();
      if (current === label) return;
      const target = Date.parse(`1 ${label}`);
      const now = Date.parse(`1 ${current}`);
      await (target > now ? this.nextMonth : this.prevMonth).click();
      await this.page.waitForLoadState('networkidle').catch(() => {});
    }
    await expect(this.currentMonth).toHaveText(label);
  }
}

export class ShiftManagementPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/schedules/shifts');
  }

  get createButton() {
    return this.page.getByTestId('shift-create');
  }
  get bulkCreateButton() {
    return this.page.getByTestId('shift-bulk-create');
  }
  get employeeSearch() {
    return this.page.getByTestId('shift-employee-search');
  }
  get departmentFilter() {
    return this.page.getByTestId('shift-department-filter');
  }
  get employeeEmpty() {
    return this.page.getByTestId('shift-employee-empty');
  }
  get noSelection() {
    return this.page.getByTestId('shift-no-selection');
  }
  get shiftCount() {
    return this.page.getByTestId('shift-count');
  }
  get calendar() {
    return this.page.getByTestId('shift-calendar');
  }
  get error() {
    return this.page.getByTestId('shift-error');
  }

  employee(code: string) {
    return this.page.getByTestId(`shift-employee-item-${code}`);
  }
  deleteButton(scheduleId: string) {
    return this.page.getByTestId(`shift-delete-${scheduleId}`);
  }
  stat(key: 'hours' | 'workdays' | 'leaves' | 'overtime') {
    return this.page.getByTestId(`shift-stat-${key}`);
  }

  get list() {
    return this.page.getByTestId('shift-list');
  }
  get listEmpty() {
    return this.page.getByTestId('shift-list-empty');
  }
  row(scheduleId: string) {
    return this.page.getByTestId(`shift-row-${scheduleId}`);
  }
  editButton(scheduleId: string) {
    return this.page.getByTestId(`shift-edit-${scheduleId}`);
  }

  /**
   * Any row / control currently on screen.
   *
   * The roster ids come from the database, not from the spec, so a case that
   * only needs "some shift" asks for the first rather than threading an id in
   * from a fixture that would then have to stay in step with the seed.
   */
  get anyRow() {
    return this.page.locator('[data-testid^="shift-row-"]').first();
  }
  get anyDeleteButton() {
    return this.page.locator('[data-testid^="shift-delete-"]').first();
  }
  get anyEditButton() {
    return this.page.locator('[data-testid^="shift-edit-"]').first();
  }

  async selectEmployee(code: string): Promise<void> {
    await this.employee(code).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class ScheduleFormModal {
  constructor(private readonly page: Page) {}

  get form() {
    return this.page.getByTestId('sched-form');
  }
  get employee() {
    return this.page.getByTestId('sched-form-employee');
  }
  get date() {
    return this.page.getByTestId('sched-form-date');
  }
  get hours() {
    return this.page.getByTestId('sched-form-hours');
  }
  get start() {
    return this.page.getByTestId('sched-form-start');
  }
  get end() {
    return this.page.getByTestId('sched-form-end');
  }
  get notes() {
    return this.page.getByTestId('sched-form-notes');
  }
  get submit() {
    return this.page.getByTestId('sched-form-submit');
  }
  get cancel() {
    return this.page.getByTestId('sched-form-cancel');
  }
  /** The server's own refusal, which used to be one generic sentence (T19). */
  get formError() {
    return this.page.getByTestId('sched-form-error');
  }
  fieldError(field: string) {
    return this.page.getByTestId(`sched-form-error-${field}`);
  }
  shiftType(type: string) {
    return this.page.getByTestId(`sched-form-type-${type}`);
  }
  get contractWarning() {
    return this.page.getByTestId('sched-contract-warning');
  }
  get contractConfirm() {
    return this.page.getByTestId('sched-contract-confirm');
  }
  get contractCancel() {
    return this.page.getByTestId('sched-contract-cancel');
  }
}

export class BulkScheduleModalPage {
  constructor(private readonly page: Page) {}

  get form() {
    return this.page.getByTestId('bulk-form');
  }
  get selectAll() {
    return this.page.getByTestId('bulk-select-all');
  }
  get startDate() {
    return this.page.getByTestId('bulk-start');
  }
  get endDate() {
    return this.page.getByTestId('bulk-end');
  }
  get hours() {
    return this.page.getByTestId('bulk-hours');
  }
  get notes() {
    return this.page.getByTestId('bulk-notes');
  }
  get summary() {
    return this.page.getByTestId('bulk-summary');
  }
  get result() {
    return this.page.getByTestId('bulk-result');
  }
  get resultSuccess() {
    return this.page.getByTestId('bulk-result-success');
  }
  get resultFailed() {
    return this.page.getByTestId('bulk-result-failed');
  }
  get submit() {
    return this.page.getByTestId('bulk-submit');
  }
  get cancel() {
    return this.page.getByTestId('bulk-cancel');
  }
  /** Client-side validation and the server's refusal share this one banner. */
  get formError() {
    return this.page.getByTestId('bulk-form-error');
  }
  /**
   * The bulk modal has its OWN two-stage contract gate, separate from the one on
   * `ScheduleFormModal`. Easy to miss: submitting for an employee with no
   * contract raises it instead of sending anything, so a spec that does not know
   * about it sees a click that produces no request and no error.
   */
  get contractWarning() {
    return this.page.getByTestId('bulk-contract-warning');
  }
  get contractConfirm() {
    return this.page.getByTestId('bulk-contract-confirm');
  }
  get contractCancel() {
    return this.page.getByTestId('bulk-contract-cancel');
  }
  employee(code: string) {
    return this.page.getByTestId(`bulk-employee-${code}`);
  }
  skipDay(day: number) {
    return this.page.getByTestId(`bulk-skip-${day}`);
  }
  shiftType(type: string) {
    return this.page.getByTestId(`bulk-type-${type}`);
  }
  errorRow(n: number) {
    return this.page.getByTestId(`bulk-error-row-${n}`);
  }
}

export class MyCalendarPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-calendar');
  }

  get createButton() {
    return this.page.getByTestId('mycal-create');
  }
  get bulkCreateButton() {
    return this.page.getByTestId('mycal-bulk-create');
  }
  /** The create button inside the day-detail panel, pre-filled with that day. */
  get dayAddButton() {
    return this.page.getByTestId('mycal-day-add');
  }
  get empty() {
    return this.page.getByTestId('mycal-empty');
  }
  get error() {
    return this.page.getByTestId('mycal-error');
  }
  stat(key: string) {
    return this.page.getByTestId(`mycal-stat-${key}`);
  }
  event(id: string) {
    return this.page.getByTestId(`mycal-event-${id}`);
  }
  editButton(id: string) {
    return this.page.getByTestId(`mycal-edit-${id}`);
  }
  deleteButton(id: string) {
    return this.page.getByTestId(`mycal-delete-${id}`);
  }
  get anyEditButton() {
    return this.page.locator('[data-testid^="mycal-edit-"]').first();
  }
  get anyDeleteButton() {
    return this.page.locator('[data-testid^="mycal-delete-"]').first();
  }
}

// ─── Workplace: Asset Register ───────────────────────────────────────────────
//
// Row controls carry the asset TAG rather than the row's uuid, because the tag
// is the one identifier a spec already knows: it is what the spec typed into
// the create form. The assignment-scoped controls on My Assets carry the
// assignment id instead, since an employee can hold the same asset twice over
// time and only the assignment distinguishes the two custody periods.

export class AssetsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/assets');
  }

  get newButton() {
    return this.page.getByTestId('asset-new');
  }
  get search() {
    return this.page.getByTestId('asset-search');
  }
  get statusFilter() {
    return this.page.getByTestId('asset-status-filter');
  }
  get empty() {
    return this.page.getByTestId('asset-empty');
  }

  /** The four tiles. `data-value` carries the raw figure, so no rendering is parsed. */
  stat(key: 'total' | 'held' | 'available' | 'unacknowledged') {
    return this.page.getByTestId(`asset-stat-${key}`);
  }
  async statValue(
    key: 'total' | 'held' | 'available' | 'unacknowledged',
  ): Promise<number> {
    return num(await this.stat(key).getAttribute('data-value'));
  }

  // Create form (rendered once, so no id suffix).
  get formTag() {
    return this.page.getByTestId('asset-form-tag');
  }
  get formName() {
    return this.page.getByTestId('asset-form-name');
  }
  get formCategory() {
    return this.page.getByTestId('asset-form-category');
  }
  get formBranch() {
    return this.page.getByTestId('asset-form-branch');
  }
  get formSerial() {
    return this.page.getByTestId('asset-form-serial');
  }
  get formWarranty() {
    return this.page.getByTestId('asset-form-warranty');
  }
  get formSubmit() {
    return this.page.getByTestId('asset-form-submit');
  }

  row(assetTag: string) {
    return this.page.getByTestId(`asset-row-${assetTag}`);
  }
  rowStatus(assetTag: string) {
    return this.page.getByTestId(`asset-row-status-${assetTag}`);
  }
  assignButton(assetTag: string) {
    return this.page.getByTestId(`asset-assign-${assetTag}`);
  }
  returnButton(assetTag: string) {
    return this.page.getByTestId(`asset-return-${assetTag}`);
  }
  deleteButton(assetTag: string) {
    return this.page.getByTestId(`asset-delete-${assetTag}`);
  }

  get anyRow() {
    return this.page.locator('[data-testid^="asset-row-"]').first();
  }

  /** Fills and submits the create form. Returns nothing — the spec asserts the row. */
  async create(fields: {
    tag: string;
    name: string;
    category?: string;
    branch?: string;
    serial?: string;
    warranty?: string;
  }): Promise<void> {
    await this.newButton.click();
    await this.formTag.fill(fields.tag);
    await this.formName.fill(fields.name);
    if (fields.category) await this.formCategory.selectOption({ label: fields.category });
    if (fields.branch) await this.formBranch.selectOption({ label: fields.branch });
    if (fields.serial) await this.formSerial.fill(fields.serial);
    if (fields.warranty) await this.formWarranty.fill(fields.warranty);
    await this.formSubmit.click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class AssetAssignDialog {
  constructor(private readonly page: Page) {}

  get root() {
    return this.page.getByTestId('asset-assign-modal');
  }
  get employee() {
    return this.page.getByTestId('asset-assign-employee');
  }
  get condition() {
    return this.page.getByTestId('asset-assign-condition');
  }
  get cancel() {
    return this.page.getByTestId('asset-assign-cancel');
  }
  get submit() {
    return this.page.getByTestId('asset-assign-submit');
  }
}

export class AssetReturnDialog {
  constructor(private readonly page: Page) {}

  get root() {
    return this.page.getByTestId('asset-return-modal');
  }
  get condition() {
    return this.page.getByTestId('asset-return-condition');
  }
  /** AVAILABLE | IN_REPAIR | LOST | RETIRED — the asset's destination state. */
  get status() {
    return this.page.getByTestId('asset-return-status');
  }
  get cancel() {
    return this.page.getByTestId('asset-return-cancel');
  }
  get submit() {
    return this.page.getByTestId('asset-return-submit');
  }
}

export class MyAssetsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-assets');
  }

  get openSection() {
    return this.page.getByTestId('my-assets-open');
  }
  get pastSection() {
    return this.page.getByTestId('my-assets-past');
  }
  get empty() {
    return this.page.getByTestId('my-assets-empty');
  }
  get unacknowledged() {
    return this.page.getByTestId('my-assets-unacknowledged');
  }
  async unacknowledgedCount(): Promise<number> {
    return num(await this.unacknowledged.getAttribute('data-count'));
  }

  row(assignmentId: string) {
    return this.page.getByTestId(`my-asset-row-${assignmentId}`);
  }
  /** Carries `data-acknowledged="true|false"` — the receipt state without reading text. */
  ackState(assignmentId: string) {
    return this.page.getByTestId(`my-asset-ack-state-${assignmentId}`);
  }
  async isAcknowledged(assignmentId: string): Promise<boolean> {
    return (await this.ackState(assignmentId).getAttribute('data-acknowledged')) === 'true';
  }

  /** Two distinct buttons: this one reveals the note box, `ackConfirm` calls the API. */
  ackButton(assignmentId: string) {
    return this.page.getByTestId(`asset-acknowledge-${assignmentId}`);
  }
  ackNote(assignmentId: string) {
    return this.page.getByTestId(`asset-acknowledge-note-${assignmentId}`);
  }
  ackConfirm(assignmentId: string) {
    return this.page.getByTestId(`asset-acknowledge-confirm-${assignmentId}`);
  }

  async acknowledge(assignmentId: string, note?: string): Promise<void> {
    await this.ackButton(assignmentId).click();
    if (note) await this.ackNote(assignmentId).fill(note);
    await this.ackConfirm(assignmentId).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

/**
 * The offboarding clearance banner, as rendered inside a termination request.
 *
 * `data-clearance-state` is the discriminator rather than the visible copy,
 * which is the whole point of this object: the journey that matters is "an
 * outstanding asset BLOCKS a termination", and that must be assertable without
 * reading a translated sentence.
 *
 * Scope it per request where more than one panel is on screen:
 *   new ClearanceBannerPanel(page, requestId)
 */
export class ClearanceBannerPanel {
  constructor(
    private readonly page: Page,
    private readonly requestId?: string,
  ) {}

  private get scope() {
    return this.requestId
      ? this.page.getByTestId(`term-clearance-banner-${this.requestId}`)
      : this.page;
  }

  get root() {
    return this.scope.getByTestId('clearance-banner');
  }
  get status() {
    return this.scope.getByTestId('clearance-status');
  }

  async state(): Promise<'loading' | 'cleared' | 'blocked' | null> {
    const value = await this.root.getAttribute('data-clearance-state');
    return value as 'loading' | 'cleared' | 'blocked' | null;
  }
  async isCleared(): Promise<boolean> {
    return (await this.status.getAttribute('data-cleared')) === 'true';
  }
  async openAssetCount(): Promise<number> {
    return num(await this.status.getAttribute('data-open-assets'));
  }

  openAsset(assignmentId: string) {
    return this.scope.getByTestId(`clearance-open-asset-${assignmentId}`);
  }

  /**
   * The loan half of clearance.
   *
   * This accessor was deliberately absent while R20 stood: `ClearanceStatus` in
   * `types/asset.ts` carried `{ cleared, openAssets }` only, so a loan-blocked
   * employee rendered "Blocked: 0 company assets not returned" — naming no
   * reason and then advising a remedy that could not apply. The type now
   * carries `outstandingLoans`, and the banner renders a row per obligation.
   */
  outstandingLoan(loanId: string) {
    return this.scope.getByTestId(`clearance-outstanding-loan-${loanId}`);
  }
  async outstandingLoanCount(): Promise<number> {
    return num(await this.status.getAttribute('data-outstanding-loans'));
  }
}

// ─── Workplace: Letter Requests ──────────────────────────────────────────────

export class LettersPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/letters');
  }

  get statusFilter() {
    return this.page.getByTestId('letter-status-filter');
  }
  get empty() {
    return this.page.getByTestId('letter-empty');
  }

  row(id: string) {
    return this.page.getByTestId(`letter-row-${id}`);
  }
  rowStatus(id: string) {
    return this.page.getByTestId(`letter-row-status-${id}`);
  }
  issueButton(id: string) {
    return this.page.getByTestId(`letter-issue-${id}`);
  }
  rejectButton(id: string) {
    return this.page.getByTestId(`letter-reject-${id}`);
  }
  rejectReason(id: string) {
    return this.page.getByTestId(`letter-reject-reason-${id}`);
  }
  rejectSubmit(id: string) {
    return this.page.getByTestId(`letter-reject-submit-${id}`);
  }
  downloadButton(id: string) {
    return this.page.getByTestId(`letter-download-${id}`);
  }

  get anyRow() {
    return this.page.locator('[data-testid^="letter-row-"]').first();
  }

  /** Opens the reason box, fills it, submits. Omit `reason` to test the client's own gate. */
  async reject(id: string, reason?: string): Promise<void> {
    await this.rejectButton(id).click();
    if (reason !== undefined) await this.rejectReason(id).fill(reason);
    await this.rejectSubmit(id).click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class MyLettersPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-letters');
  }

  get requestOpen() {
    return this.page.getByTestId('letter-request-open');
  }
  get type() {
    return this.page.getByTestId('letter-request-type');
  }
  get locale() {
    return this.page.getByTestId('letter-request-locale');
  }
  get addressedTo() {
    return this.page.getByTestId('letter-request-addressed-to');
  }
  get purpose() {
    return this.page.getByTestId('letter-request-purpose');
  }
  get submit() {
    return this.page.getByTestId('letter-request-submit');
  }
  get empty() {
    return this.page.getByTestId('my-letters-empty');
  }

  row(id: string) {
    return this.page.getByTestId(`my-letter-row-${id}`);
  }
  status(id: string) {
    return this.page.getByTestId(`my-letter-status-${id}`);
  }
  downloadButton(id: string) {
    return this.page.getByTestId(`my-letter-download-${id}`);
  }

  get anyRow() {
    return this.page.locator('[data-testid^="my-letter-row-"]').first();
  }

  /**
   * Files a request. `templateKey` is the option VALUE, not its label — the
   * labels are translated and the value is the key the API receives.
   */
  async request(fields: {
    templateKey: string;
    locale?: 'en' | 'ar';
    addressedTo?: string;
    purpose?: string;
  }): Promise<void> {
    await this.requestOpen.click();
    await this.type.selectOption(fields.templateKey);
    if (fields.locale) await this.locale.selectOption(fields.locale);
    if (fields.addressedTo) await this.addressedTo.fill(fields.addressedTo);
    if (fields.purpose) await this.purpose.fill(fields.purpose);
    await this.submit.click();
    await this.page.waitForLoadState('networkidle').catch(() => {});
  }
}

export class MyDocumentsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/my-documents');
  }

  get search() {
    return this.page.getByTestId('document-search');
  }
  get kindFilter() {
    return this.page.getByTestId('document-kind-filter');
  }
  get empty() {
    return this.page.getByTestId('document-empty');
  }

  row(id: string) {
    return this.page.getByTestId(`document-row-${id}`);
  }
  downloadButton(id: string) {
    return this.page.getByTestId(`document-download-${id}`);
  }

  get anyRow() {
    return this.page.locator('[data-testid^="document-row-"]').first();
  }
}

/**
 * The loan product catalogue.
 *
 * ADMIN-only: every other role is shown the rule rather than a table of
 * controls that refuse, so `isForbidden()` is a first-class question here.
 */
export class LoanProductsPage {
  constructor(private readonly page: Page) {}

  async open(): Promise<void> {
    await open(this.page, '/dashboard/advance-loans/products');
  }

  async isForbidden(): Promise<boolean> {
    return (await this.page.getByTestId('loan-products-forbidden').count()) > 0;
  }

  row(code: string) {
    return this.page.locator(`[data-testid="loan-product-row"][data-code="${code}"]`);
  }

  async isOffered(code: string): Promise<boolean | null> {
    const row = this.row(code);
    if ((await row.count()) === 0) return null;
    return (
      (await row.getByTestId('loan-product-state').getAttribute('data-active')) === 'true'
    );
  }

  async create(opts: {
    code: string;
    name: string;
    category?: 'LOAN' | 'ADVANCE';
    interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
    rate?: number;
    defaultInstallments?: number;
    maxInstallments?: number;
    priority?: number;
  }): Promise<void> {
    await this.page.getByTestId('loan-product-new').click();
    const modal = this.page.getByTestId('loan-product-modal');
    await modal.waitFor({ state: 'visible' });

    await modal.getByTestId('loan-product-code').fill(opts.code);
    await modal.getByTestId('loan-product-name').fill(opts.name);
    if (opts.category) {
      await modal.getByTestId('loan-product-category').selectOption(opts.category);
    }
    if (opts.interestMethod) {
      await modal
        .getByTestId('loan-product-interest-method')
        .selectOption(opts.interestMethod);
    }
    if (opts.rate != null) {
      await modal.getByTestId('loan-product-rate').fill(String(opts.rate));
    }
    if (opts.defaultInstallments != null) {
      await modal
        .getByTestId('loan-product-default-installments')
        .fill(String(opts.defaultInstallments));
    }
    if (opts.maxInstallments != null) {
      await modal
        .getByTestId('loan-product-max-installments')
        .fill(String(opts.maxInstallments));
    }
    if (opts.priority != null) {
      await modal.getByTestId('loan-product-priority').fill(String(opts.priority));
    }

    await modal.getByTestId('loan-product-save').click();
  }

  async retire(code: string): Promise<void> {
    await this.row(code).getByTestId('loan-product-toggle').click();
  }

  /** Deletes through the app's own confirm dialog, not the browser's. */
  async delete(code: string): Promise<void> {
    await this.row(code).getByTestId('loan-product-delete').click();
    await confirmDialog(this.page);
  }
}
