import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, selectBranch, ToastArea } from '../../pages';
import { LoanLifecyclePage } from '../../pages/loan-lifecycle';
import {
  marker,
  OPEN_STATUSES,
  retire,
  retireAllMarked,
  ensureAllowance,
  loanOf,
  makeEmployee,
  terminateEmployee,
  withSetting,
  flagFlipAllowed,
} from '../../loan-support';

/**
 * The FRONT DOOR of the loan module: everything that happens before anyone has
 * decided anything.
 *
 * `loans.admin-employee.spec.ts` covers the decision and
 * `finance-loan-lifecycle.spec.ts` covers what happens to the money afterwards.
 * This file is the half neither of them touches — what may be filed at all, by
 * whom, and what the requester is told when the answer is no.
 *
 * ## Why creation deserves its own file
 *
 * Filing a request is the only place in the module where FIVE separate gates
 * are stacked on one action, and each of them refuses in a different voice:
 *
 *   1. **The field.** `loan-amount` carries `required min="0.01"` and
 *      `loan-installments` carries `max={advance_loan_max_installments}`. The
 *      form is `noValidate`, so these no longer cancel the submit — they stay
 *      for their semantics and for the mobile keyboard, and the field still
 *      reports `rangeUnderflow`/`rangeOverflow`, but the APP gets the word.
 *   2. **`handleSubmit`.** Two client toasts, quoted verbatim below. These were
 *      dead code until `noValidate` was added — the browser's own bubble, in
 *      the BROWSER's locale, fired first on an EN+AR product.
 *   3. **`CreateAdvanceLoanDto`.** `@IsIn` on the type, `@IsNumber @IsPositive`
 *      on the amount, `@IsInt @Min(1) @Max(60)` on the instalments. The global
 *      pipe runs `whitelist + forbidNonWhitelisted + transform` WITHOUT
 *      `enableImplicitConversion`, which is why a numeric STRING is a 400.
 *   4. **`LoanEligibilityService`.** Ten rules, evaluated by the same call the
 *      panel makes, so a refusal is visible before submit rather than arriving
 *      as an opaque 400 afterwards. `create()` re-runs it and turns the FIRST
 *      failing rule into the message.
 *   5. **`@Roles('HR_MANAGER','MANAGER','EMPLOYEE')`.** ADMIN is deliberately
 *      absent — admins administer the loan book, they do not borrow from it.
 *
 * A case that only proved "the request was refused" would pass no matter which
 * of the five did the refusing, and would keep passing if four of them were
 * deleted. So every refusal here is pinned to its layer: a native validity
 * flag, a toast string, a 400, or a named eligibility row.
 *
 * ## Two owners, on purpose
 *
 * The browser half runs in the `employee` project, whose session belongs to
 * `employee1` — so a request filed through the FORM belongs to `employee1` and
 * only `employee1`'s API client can read it back. The API half deliberately
 * files as `employee2` instead, because `loan_max_active_per_employee` is 2 and
 * `loans.admin-employee.spec.ts` / `finance-loan-lifecycle.spec.ts` are already
 * filing against `employee1` from other workers. Splitting the owners means the
 * two halves of this file cannot exhaust each other's allowance.
 *
 * Everything filed here carries `pw-loancreate-` in its `reason`, so
 * `ensureAllowance` sweeps this file's own leftovers before it will touch
 * anything belonging to a spec that is still running.
 *
 * ## ADMIN is not a requester and cannot be made into one
 *
 * Asserted twice, because the two halves prove different things: the screen
 * offers an admin no `loan-new` button (a UI decision), and `POST
 * /advance-loans` answers 403 when asked directly (the rule). Either alone is
 * one `curl` away from meaningless.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The stable half of the marker — what identifies a request as THIS FILE'S,
 * across runs. `marker()` adds a per-run suffix, so a leftover can be dated as
 * well as owned.
 */
const MARKER_PREFIX = 'pw-loancreate-';

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const MARK = marker(MARKER_PREFIX);

/** The fallback requester, sanctioned when `makeEmployee` is unavailable. */
const API_OWNER_EMAIL = 'employee2@company.com';
const API_OWNER_PASSWORD = 'Password123!';

interface LoanRow {
  id: string;
  status: string;
  type: string;
  amount: string;
  installments: number;
  installmentAmount: string | null;
  interestMethod?: string;
  interestRate?: string | number;
  reason: string | null;
  attachments?: Array<{ id: string }>;
}

type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

interface EligibilityCheck {
  code: string;
  label: string;
  status: CheckStatus;
  limit?: number | string | null;
  actual?: number | string | null;
  detail?: string;
}

interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  maxEligibleAmount: number | null;
  monthlyNet: number;
  existingEmis: number;
}

/**
 * The what-if result, whichever envelope it arrives in.
 *
 * `AdvanceLoansService.checkEligibility` returns its own `{ success, data }`
 * and there is no global response interceptor, so `ApiClient.unwrap` already
 * peels one layer. Peeling defensively rather than depending on the depth is
 * what stops this file breaking the day a wrapper is added or removed.
 */
async function eligibilityOf(
  api: ApiClient,
  body: Record<string, unknown>,
): Promise<EligibilityResult> {
  const raw = await api.post<any>('/advance-loans/eligibility', body);
  return (raw?.data ?? raw) as EligibilityResult;
}

/** One named rule out of a result, or `undefined` when it was never emitted. */
function ruleOf(result: EligibilityResult, code: string): EligibilityCheck | undefined {
  return (result.checks ?? []).find((c) => c.code === code);
}

/** Every request this owner filed whose reason carries `needle`. */
async function mineWith(owner: ApiClient, needle: string): Promise<LoanRow[]> {
  const raw = await owner
    .get<LoanRow[] | { data?: LoanRow[] }>('/advance-loans/my-requests')
    .catch(() => [] as LoanRow[]);
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  return list.filter((l) => (l.reason ?? '').includes(needle));
}

/**
 * The parts of `ValidityState` this file reasons about.
 *
 * Read from the live element rather than inferred, because the whole claim of
 * the "browser refuses first" cases is WHICH validator rejected the value —
 * and a test that only checked "nothing was filed" could not tell the native
 * one from the app's own.
 */
async function validityOf(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<{ valid: boolean; valueMissing: boolean; rangeUnderflow: boolean; rangeOverflow: boolean }> {
  return page.getByTestId(testId).evaluate((node) => {
    const el = node as HTMLInputElement;
    return {
      valid: el.validity.valid,
      valueMissing: el.validity.valueMissing,
      rangeUnderflow: el.validity.rangeUnderflow,
      rangeOverflow: el.validity.rangeOverflow,
    };
  });
}

/**
 * Opens the create modal and fills it, WITHOUT submitting.
 *
 * `AdvanceLoansPage.submitRequest` waits for the modal to detach, which is the
 * right shape for a request that succeeds and exactly the wrong one for the
 * refusal cases — where the modal staying open is half of the claim.
 */
async function openCreateForm(
  page: import('@playwright/test').Page,
  opts: { type: 'ADVANCE' | 'LOAN'; amount?: string; installments?: string; reason?: string },
) {
  const loans = new AdvanceLoansPage(page);
  await loans.open();
  await loans.openTab('my');

  await page.getByTestId('loan-new').click();
  const modal = page.getByTestId('loan-create-modal');
  await expect(modal).toBeVisible();

  await modal.getByTestId(`loan-type-${opts.type}`).click();
  if (opts.amount !== undefined) await modal.getByTestId('loan-amount').fill(opts.amount);
  if (opts.type === 'LOAN' && opts.installments !== undefined) {
    await modal.getByTestId('loan-installments').fill(opts.installments);
  }
  if (opts.reason !== undefined) await modal.getByTestId('loan-reason').fill(opts.reason);
  return modal;
}

// ───────────────────────────────────────────────────────────────────────────
// Filing a request, through the form
// ───────────────────────────────────────────────────────────────────────────

test.describe('a requester files an advance and a loan through the form', () => {
  let uiOwner: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  /** Requests this test created, retired the moment it finishes. */
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      uiOwner = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('employee')) return;
    for (const id of scratch) await retire(id, uiOwner, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('employee') && uiOwner && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await uiOwner?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'filing a request belongs to the requester');
    });

    test('an ADVANCE is filed and lands PENDING, recovered in a single cycle', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      await ensureAllowance(uiOwner, adminApi, 300, MARKER_PREFIX);

      const reason = `${MARK} — advance through the form`;
      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      // `selectBranch` leaves the browser on /dashboard — the create button
      // only exists on the loans screen, so the list has to be opened before
      // the modal can be reached.
      await loans.open();
      await loans.openTab('my');
      await loans.submitRequest({ type: 'ADVANCE', amount: 300, reason });

      // Read the record back rather than the row: the claim is that the
      // request exists with these terms, not that a list rendered.
      await expect.poll(() => mineWith(uiOwner, reason).then((r) => r.length), {
        timeout: 15_000,
      }).toBe(1);
      const created = (await mineWith(uiOwner, reason))[0];
      scratch.push(created.id);

      expect(created.type).toBe('ADVANCE');
      expect(created.status).toBe('PENDING');
      expect(Number(created.amount)).toBe(300);
      // An advance is deducted in full from the next cycle. `create()` pins
      // this to 1 regardless of what the payload asked for — the field is not
      // even rendered for an ADVANCE.
      expect(created.installments, 'an advance was filed with a repayment period').toBe(1);
      // Nothing is settled until an approver acts, so there is no instalment
      // figure yet.
      expect(created.installmentAmount).toBeFalsy();

      await loans.open();
      await loans.openTab('my');
      await expect.poll(() => loans.rowStatus(created.id), { timeout: 15_000 }).toBe('PENDING');

      settle(problems, 'filing a salary advance');
    });

    test('a LOAN carries the requester\'s preferred repayment period into the queue', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      await ensureAllowance(uiOwner, adminApi, 600, MARKER_PREFIX);

      const reason = `${MARK} — loan through the form`;
      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      // Same as above: the create button lives on the loans screen, not on the
      // dashboard `selectBranch` leaves us on.
      await loans.open();
      await loans.openTab('my');
      await loans.submitRequest({ type: 'LOAN', amount: 600, installments: 6, reason });

      await expect.poll(() => mineWith(uiOwner, reason).then((r) => r.length), {
        timeout: 15_000,
      }).toBe(1);
      const created = (await mineWith(uiOwner, reason))[0];
      scratch.push(created.id);

      expect(created.type).toBe('LOAN');
      expect(created.status).toBe('PENDING');
      // A PREFERENCE, not a decision: the approver's number is what the
      // schedule is built from, which is `loans.admin-employee.spec.ts`'s
      // subject. What matters here is that the requester's number survived the
      // trip at all.
      expect(created.installments, 'the preferred repayment period never reached the record')
        .toBe(6);
      expect(created.installmentAmount, 'an undecided request already had an instalment')
        .toBeFalsy();

      settle(problems, 'filing a loan with a preferred repayment period');
    });

    test('a PDF attached to the form arrives on the request', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      await ensureAllowance(uiOwner, adminApi, 250, MARKER_PREFIX);

      const reason = `${MARK} — advance with a supporting document`;
      await selectBranch(page, branchId);
      const modal = await openCreateForm(page, { type: 'ADVANCE', amount: '250', reason });

      // The file input carries no test id — it is a bare `<input type="file">`
      // inside the modal, so it is addressed structurally within an element
      // that IS addressed by test id.
      await modal.locator('input[type="file"]').setInputFiles({
        name: `${MARK}-payslip.pdf`,
        mimeType: 'application/pdf',
        // A minimal but genuine PDF header: the service checks the mime type
        // and the size, and a byte-empty file is a different case.
        buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
      });

      await modal.getByTestId('loan-submit').click();
      await modal.waitFor({ state: 'detached', timeout: 20_000 });

      await expect.poll(() => mineWith(uiOwner, reason).then((r) => r.length), {
        timeout: 15_000,
      }).toBe(1);
      const created = (await mineWith(uiOwner, reason))[0];
      scratch.push(created.id);

      // The upload is a SECOND request, fired after create resolves — so it is
      // polled rather than read once, and it is the record that is asked, not
      // the toast that said "submitted".
      await expect
        .poll(
          async () => ((await loanOf(uiOwner, created.id)) as unknown as LoanRow).attachments?.length ?? 0,
          { timeout: 15_000 },
        )
        .toBe(1);

      // And it is on the screen an approver would look at, not merely in the
      // database — the section is not drawn at all when the array is empty.
      const detail = new LoanLifecyclePage(page);
      await detail.open(created.id);
      await expect.poll(() => detail.attachmentCount(), { timeout: 20_000 }).toBe(1);

      settle(problems, 'filing a request with a PDF attachment');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The browser gets the first word
// ───────────────────────────────────────────────────────────────────────────

/**
 * Four values the requirement expects the APP to refuse, which the BROWSER
 * refuses first.
 *
 * `loan-amount` is `required min="0.01"` and `loan-installments` is
 * `max={maxInstallments}`, on a `<form>` with no `noValidate`. Native
 * constraint validation therefore cancels the submit event before React's
 * `onSubmit` runs, and the two toasts in `handleSubmit` — quoted in the BUG?
 * lines below — are unreachable through the form.
 *
 * Every case here asserts BOTH halves: the specific `ValidityState` flag that
 * fired (which names the layer), and that nothing was filed (which is the
 * outcome the requirement actually cares about). Judged `strict`, because a
 * submit that never happens produces no HTTP traffic at all.
 */
test.describe('the form states its own refusal, in the app’s words', () => {
  let uiOwner: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let maxInstallments = 12;
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      uiOwner = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
      // Read the ceiling the FORM was rendered from rather than assuming the
      // default of 12 — it is a system setting, and it is not pinned by the
      // e2e baseline.
      const publicSettings = await adminApi.get<Record<string, string>>('/system-settings/public');
      maxInstallments = Number(publicSettings?.advance_loan_max_installments) || 12;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await uiOwner?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the request form belongs to the requester');
    });

    test('an amount of zero never leaves the form', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const reason = `${MARK} — zero amount`;
      await selectBranch(page, branchId);
      const modal = await openCreateForm(page, { type: 'ADVANCE', amount: '0', reason });
      const toasts = new ToastArea(page);

      await modal.getByTestId('loan-submit').click();

      // The form carries `noValidate`, so the browser no longer cancels the
      // submit and `handleSubmit` runs its own guard. `min="0.01"` is kept for
      // its semantics and for the mobile keyboard, so the field still reports
      // rangeUnderflow — but it is the APP that refuses, in the app's own
      // words, rather than a browser bubble localised to the browser's locale.
      const validity = await validityOf(page, 'loan-amount');
      expect(validity.rangeUnderflow, 'zero passed the native minimum of 0.01').toBe(true);
      expect(
        (await toasts.latest())?.text,
        'the app did not get to state its own refusal',
      ).toBe('Please choose a type and enter a positive amount');

      expect(await modal.isVisible(), 'a refused submit closed its own form').toBe(true);
      expect((await mineWith(uiOwner, reason)).length, 'a zero-amount request was filed').toBe(0);

      settle(problems, 'submitting the request form with a zero amount');
    });

    test('a negative amount never leaves the form', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const reason = `${MARK} — negative amount`;
      await selectBranch(page, branchId);
      const modal = await openCreateForm(page, { type: 'ADVANCE', amount: '-500', reason });
      const toasts = new ToastArea(page);

      await modal.getByTestId('loan-submit').click();

      // Same as the zero case: `noValidate` means `handleSubmit`'s
      // `amount <= 0` branch is live code again, so the app states the refusal
      // itself instead of deferring to a browser bubble.
      const validity = await validityOf(page, 'loan-amount');
      expect(validity.rangeUnderflow, 'a negative amount passed the native minimum').toBe(true);
      expect((await toasts.latest())?.text).toBe(
        'Please choose a type and enter a positive amount',
      );

      expect(await modal.isVisible(), 'a refused submit closed its own form').toBe(true);
      expect((await mineWith(uiOwner, reason)).length, 'a negative request was filed').toBe(0);

      settle(problems, 'submitting the request form with a negative amount');
    });

    test('an empty amount never leaves the form', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const reason = `${MARK} — empty amount`;
      await selectBranch(page, branchId);
      // Deliberately NOT filled: the field is `required`, and an untouched
      // form is what a distracted user actually submits.
      const modal = await openCreateForm(page, { type: 'ADVANCE', reason });
      const toasts = new ToastArea(page);

      // With no amount the eligibility panel is not even mounted — it returns
      // null below zero, which is what keeps the what-if call off the wire
      // until there is something to judge.
      expect(await page.getByTestId('loan-eligibility-panel').count()).toBe(0);

      await modal.getByTestId('loan-submit').click();

      const validity = await validityOf(page, 'loan-amount');
      expect(validity.valueMissing, 'an empty required amount was considered valid').toBe(true);
      expect((await toasts.latest())?.text).toBe(
        'Please choose a type and enter a positive amount',
      );

      expect(await modal.isVisible(), 'a refused submit closed its own form').toBe(true);
      expect((await mineWith(uiOwner, reason)).length, 'an amount-less request was filed').toBe(0);

      settle(problems, 'submitting the request form with no amount');
    });

    test('a repayment period above the configured ceiling never leaves the form', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const reason = `${MARK} — over the instalment ceiling`;
      await selectBranch(page, branchId);
      const modal = await openCreateForm(page, {
        type: 'LOAN',
        amount: '600',
        installments: String(maxInstallments + 1),
        reason,
      });
      const toasts = new ToastArea(page);

      await modal.getByTestId('loan-submit').click();

      // `noValidate` makes the app's own range guard reachable, so the
      // documented sentence is what the user actually sees. `max` stays on the
      // field for its semantics; it no longer pre-empts the app.
      const validity = await validityOf(page, 'loan-installments');
      expect(validity.rangeOverflow, `${maxInstallments + 1} passed the native maximum`).toBe(true);
      expect((await toasts.latest())?.text).toBe(
        `Repayment period cannot exceed ${maxInstallments} installments`,
      );

      // The amount itself was fine — this is the instalment field refusing, not
      // a second copy of the amount case.
      expect((await validityOf(page, 'loan-amount')).valid).toBe(true);

      expect(await modal.isVisible(), 'a refused submit closed its own form').toBe(true);
      expect((await mineWith(uiOwner, reason)).length, 'an over-long loan was filed').toBe(0);

      settle(problems, 'submitting the request form above the instalment ceiling');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The endpoint judges its own payload
// ───────────────────────────────────────────────────────────────────────────

/**
 * `CreateAdvanceLoanDto`, one bound at a time, over HTTP.
 *
 * These are API-only: there is no screen involved, and building the `page`
 * fixture to call `crashesOnly` on a window that never opens would cost a
 * browser per case for no assertion. The model file takes the same shape for
 * its `write-off is refused as HR` case.
 *
 * Files as `employee2` rather than as the browser's `employee1`, so a run of
 * this half cannot eat the allowance the form half is about to need.
 */
test.describe('the create endpoint judges its own payload', () => {
  let apiOwner: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  const file = (payload: Record<string, unknown>) =>
    apiOwner.post<LoanRow>('/advance-loans', payload);

  test.beforeEach(() => {
    // Gated in a hook so the case is scheduled once rather than in all four
    // projects. No `page` is involved, so nothing is built and discarded.
    test.skip(!isProject('employee'), 'one project files, or the same payload is tried four times');
  });

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      apiOwner = await ApiClient.asAccount(API_OWNER_EMAIL, API_OWNER_PASSWORD);
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('employee')) return;
    for (const id of scratch) await retire(id, apiOwner, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('employee') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await apiOwner?.dispose();
    await adminApi?.dispose();
  });

  test('an amount of zero is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@IsPositive()`, not a business rule — the request never reaches the
    // eligibility engine.
    await expect(
      file({ type: 'ADVANCE', amount: 0, reason: `${MARK} — api zero` }),
    ).rejects.toThrow(/400/);
  });

  test('a negative amount is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(
      file({ type: 'ADVANCE', amount: -1, reason: `${MARK} — api negative` }),
    ).rejects.toThrow(/400/);
  });

  test('a three-decimal amount is refused rather than silently rounded', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // `CreateAdvanceLoanDto.amount` is bounded to 2dp now. It used to be a bare
    // `@IsNumber()`, so a 3dp figure passed validation and was written into a
    // `Decimal(12,2)` column where it rounded — the loan then disagreed with
    // what was asked for, and the eligibility DTO immediately beside it DID
    // bound this, so the two doors into the same money disagreed.
    await expect(
      file({ type: 'ADVANCE', amount: 0.001, reason: `${MARK} — api three decimals` }),
      'a sub-cent amount was accepted',
    ).rejects.toThrow(/400[\s\S]*amount must be a number conforming to the specified constraints/);
  });

  test('the largest representable amount is accepted, one unit above it is not', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await ensureAllowance(apiOwner, adminApi, 1, MARKER_PREFIX);

    // `CreateAdvanceLoanDto.amount` now carries `@Max(9999999999.99)`, matching
    // `EligibilityCheckDto` — so the ceiling is a property of the FIELD, and the
    // requester is told about a limit rather than about their take-home pay
    // several layers later. `@Max` is inclusive, so the largest representable
    // amount is the last accepted value, not the first refused one.
    //
    // Note what does NOT refuse it: `NET_PAY_AFTER_EMI` is guarded on
    // `monthlyNet > 0`, and every login-capable seeded account carries
    // `baseSalary: 0` with no salary components — so an advance of ANY size
    // clears every affordability rule for them. See
    // docs/LOAN-ADVANCES-GAP-REPORT.md §24.8: until the baseline gives these
    // accounts a salary, an affordability assertion written against one proves
    // nothing. The field bound is the only thing genuinely holding this door.
    const created = await file({
      type: 'ADVANCE',
      amount: 9999999999.99,
      reason: `${MARK} — api ceiling`,
    });
    scratch.push(created.id);
    expect(created.status).toBe('PENDING');
    expect(Number(created.amount)).toBe(9999999999.99);
  });

  test('an amount above the eligibility ceiling is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(
      file({ type: 'ADVANCE', amount: 10000000000, reason: `${MARK} — api over ceiling` }),
    ).rejects.toThrow(/400/);
  });

  test('zero instalments are refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@Min(1)`. A loan recovered in no instalments is a loan nobody repays.
    await expect(
      file({ type: 'LOAN', amount: 600, installments: 0, reason: `${MARK} — api zero terms` }),
    ).rejects.toThrow(/400/);
  });

  test('sixty-one instalments are refused, one past the DTO maximum', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@Max(60)` on the DTO, which is a HARDER bound than the configurable
    // `advance_loan_max_installments` the eligibility engine applies — so this
    // one never reaches the engine at all.
    await expect(
      file({ type: 'LOAN', amount: 600, installments: 61, reason: `${MARK} — api 61 terms` }),
    ).rejects.toThrow(/400/);
  });

  test('a type the module does not have is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(
      file({ type: 'MORTGAGE', amount: 600, reason: `${MARK} — api bad type` }),
    ).rejects.toThrow(/400/);
  });

  test('a payload with no type is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(file({ amount: 600, reason: `${MARK} — api no type` })).rejects.toThrow(/400/);
  });

  test('a payload with no amount is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(file({ type: 'ADVANCE', reason: `${MARK} — api no amount` })).rejects.toThrow(
      /400/,
    );
  });

  test('an amount sent as a string is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // The global pipe runs `transform: true` WITHOUT
    // `enableImplicitConversion`, so `"500"` stays a string and `@IsNumber()`
    // rejects it. Worth pinning: turning implicit conversion on would silently
    // widen every numeric field in the app.
    await expect(
      file({ type: 'ADVANCE', amount: '500', reason: `${MARK} — api string amount` }),
    ).rejects.toThrow(/400/);
  });

  test('a natively filed loan is interest-free, because there is no other native path', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await ensureAllowance(apiOwner, adminApi, 600, MARKER_PREFIX);

    const created = await file({
      type: 'LOAN',
      amount: 600,
      installments: 6,
      reason: `${MARK} — api interest-free`,
    });
    scratch.push(created.id);

    // `create()` writes no interest fields, so the row takes the schema
    // defaults (`interestMethod NONE`, `interestRate 0`) — and
    // `loan_interest_enabled` is pinned `'false'` in the e2e baseline. Interest
    // reaches a loan only through the IMPORTER, which carries its own columns.
    // So this is a claim about the door, not about the arithmetic: nothing
    // filed through it can ever bear interest.
    const record = (await loanOf(adminApi, created.id)) as unknown as LoanRow;
    expect(record.interestMethod, 'a natively filed loan carried an interest method').toBe('NONE');
    expect(Number(record.interestRate), 'a natively filed loan carried an interest rate').toBe(0);
  });

  test('an employee may run several requests at once, up to the configured cap', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await ensureAllowance(apiOwner, adminApi, 100, MARKER_PREFIX);

    // The cap and the current count both come from the SERVER's own rule row,
    // not from a constant here — `loan_max_active_per_employee` is a setting,
    // and this account is shared with other specs.
    const before = await eligibilityOf(apiOwner, { amount: 100, installments: 1, type: 'ADVANCE' });
    const cap = ruleOf(before, 'MAX_ACTIVE_LOANS');
    expect(cap, 'the eligibility engine emitted no active-loan rule').toBeTruthy();

    const limit = Number(cap!.limit);
    const room = limit - Number(cap!.actual);
    test.skip(room < 2, 'this account has no room for two more requests right now');

    for (let i = 0; i < room; i++) {
      const created = await file({
        type: 'ADVANCE',
        amount: 100,
        reason: `${MARK} — concurrent request ${i + 1} of ${room}`,
      });
      scratch.push(created.id);
      // Each one has to still be OPEN, or "several at once" is not what was
      // proved — a request that closed itself would leave room for the next.
      expect(OPEN_STATUSES, 'a freshly filed request is not counted as live').toContain(
        created.status,
      );
    }

    // The cap is a cap, not a suggestion. This is the same rule the panel
    // shows, arriving as the 400 it becomes after submit.
    const after = await eligibilityOf(apiOwner, { amount: 100, installments: 1, type: 'ADVANCE' });
    expect(ruleOf(after, 'MAX_ACTIVE_LOANS')?.status).toBe('FAIL');
    expect(Number(ruleOf(after, 'MAX_ACTIVE_LOANS')?.actual)).toBe(limit);
    await expect(
      file({ type: 'ADVANCE', amount: 100, reason: `${MARK} — one past the cap` }),
    ).rejects.toThrow(/400/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// An ADMIN administers the loan book and does not borrow from it
// ───────────────────────────────────────────────────────────────────────────

/**
 * The one role gate on creation, from both sides.
 *
 * `@Roles('HR_MANAGER','MANAGER','EMPLOYEE')` on `POST /advance-loans` omits
 * ADMIN — the only route in the module that does. The screen agrees via
 * `canRequest = !!user.employeeId && user.role !== 'ADMIN'`. Two assertions
 * because they are two different mechanisms and either could be removed while
 * the other kept the test green.
 */
test.describe('an ADMIN cannot file a request', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin') && !isProject('employee')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test.describe('over the API', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'one project asks, or the same 403 is proved four times');
    });

    test('the endpoint answers 403 when an admin asks directly', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      // 403 and not 400: this is the decorator refusing the ROLE, before any
      // payload is looked at. A hidden button is a UI decision; this is the
      // rule.
      await expect(
        adminApi.post('/advance-loans', {
          type: 'ADVANCE',
          amount: 100,
          reason: `${MARK} — admin filing for themselves`,
        }),
      ).rejects.toThrow(/403/);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the admin view of the loan book');
    });

    test('the screen offers an admin no way to file one', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();

      // The administrative controls ARE offered — this is not a blanket denial,
      // it is the specific absence of a requester control on a screen the admin
      // otherwise owns.
      await expect(page.getByTestId('loan-tab-all')).toBeVisible();
      expect(
        await page.getByTestId('loan-new').count(),
        'an admin was offered the request form',
      ).toBe(0);

      settle(problems, 'the admin view of the loan book');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The eligibility panel, rule by rule
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every rule the engine can emit, as its own row on the form.
 *
 * Without the panel the ten-rule engine only surfaces as an opaque 400 after
 * submit, and the requester is left guessing which of the ten refused them. The
 * claim is that each rule is NAMED on screen — not that any particular one
 * passes, which depends on what this account happens to be carrying when the
 * suite runs.
 */
test.describe('the request form names every eligibility rule before anything is filed', () => {
  let uiOwner: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  /**
   * Every code `LoanEligibilityService.evaluate` pushes unconditionally, in the
   * order it pushes them.
   */
  const ALWAYS_EMITTED = [
    'MODULE_ENABLED',
    'EMPLOYEE_ACTIVE',
    'NOT_BEFORE_JOINING',
    'NOT_AFTER_RESIGNATION',
    'MIN_SERVICE',
    'MAX_ACTIVE_LOANS',
    'AMOUNT_CEILING',
    'ANNUAL_SALARY_CAP',
    'INSTALLMENT_RANGE',
    'NET_PAY_AFTER_EMI',
  ];

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      uiOwner = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await uiOwner?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the request form belongs to the requester');
    });

    test('each rule is a row of its own, with a verdict above them', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // How many of this file's requests already exist, so the claim below is
      // "the panel added none" rather than "this file has filed none".
      const filedBeforePanel = (await mineWith(uiOwner, MARK)).length;

      await selectBranch(page, branchId);
      const modal = await openCreateForm(page, { type: 'LOAN', amount: '600', installments: '6' });

      const verdict = page.getByTestId('loan-eligibility-verdict');
      await expect(verdict).toBeVisible({ timeout: 20_000 });
      expect(
        ['true', 'false'],
        'the verdict rendered without a machine-readable answer',
      ).toContain(await verdict.getAttribute('data-eligible'));

      for (const code of ALWAYS_EMITTED) {
        const row = page.getByTestId(`loan-eligibility-check-${code}`);
        await expect(row, `${code} is not named on the form`).toBeVisible();
        expect(['PASS', 'WARN', 'FAIL'], `${code} carried no status`).toContain(
          await row.getAttribute('data-status'),
        );
      }

      // BUG?: `DUPLICATE_REFERENCE` is the eleventh rule the service can emit,
      // and it is unreachable from here — `evaluate()` only pushes it when a
      // `referenceNo` is passed, `EligibilityCheckDto` has no such field and
      // `create()` never supplies one, so only the spreadsheet importer can
      // ever trip it.
      expect(
        await page.getByTestId('loan-eligibility-check-DUPLICATE_REFERENCE').count(),
        'the reference rule became reachable from the request form',
      ).toBe(0);

      // The panel publishes its own count, so a row silently dropped from the
      // list would be caught even if the loop above were shortened.
      const panel = page.getByTestId('loan-eligibility-panel');
      expect(Number(await panel.getAttribute('data-checks'))).toBe(ALWAYS_EMITTED.length);

      // Nothing was filed: the panel is a what-if and persists nothing, which
      // is what makes it safe to call on every keystroke.
      //
      // Measured against a snapshot rather than against the file's marker. The
      // earlier cases in this file legitimately FILE requests carrying `MARK`,
      // so "no request wears the marker" stopped being a statement about this
      // test the moment those cases started passing.
      expect(await modal.isVisible()).toBe(true);
      expect(
        (await mineWith(uiOwner, MARK)).length,
        'the what-if filed a request',
      ).toBe(filedBeforePanel);

      settle(problems, 'the eligibility panel on the request form');
    });

    test('a loan worth a year of pay WARNS rather than refusing', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The threshold is the employee's own pay, so it is read from the server
      // rather than guessed — `getMonthlyNetProxy` prefers active salary
      // components over the contract base and scales daily-wage staff by the
      // month's working days, none of which a constant here could track.
      const baseline = await eligibilityOf(uiOwner, {
        amount: 600,
        installments: 6,
        type: 'LOAN',
      });
      test.skip(
        !(baseline.monthlyNet > 0),
        'this account has no pay on record, so the annual cap cannot be crossed',
      );
      const yearOfPay = Math.ceil(baseline.monthlyNet * 12);

      await selectBranch(page, branchId);
      await openCreateForm(page, {
        type: 'LOAN',
        amount: String(yearOfPay),
        installments: '6',
      });

      const row = page.getByTestId('loan-eligibility-check-ANNUAL_SALARY_CAP');
      // Polled: the panel is debounced by 500ms and keeps the previous answer
      // on screen while the next one loads, so a single read lands on the
      // verdict for the amount that was there a moment ago.
      await expect
        .poll(() => row.getAttribute('data-status'), { timeout: 15_000 })
        .toBe('WARN');

      // The point of WARN: the requirement lists a loan at a year's pay as a
      // case to HANDLE, not to reject, so this rule alone must never be what
      // makes the verdict negative. `eligible` is `!checks.some(FAIL)` — a WARN
      // is invisible to it.
      const asked = await eligibilityOf(uiOwner, {
        amount: yearOfPay,
        installments: 6,
        type: 'LOAN',
      });
      expect(ruleOf(asked, 'ANNUAL_SALARY_CAP')?.status).toBe('WARN');
      expect(
        (asked.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => c.code),
        'the annual cap was counted as a failure',
      ).not.toContain('ANNUAL_SALARY_CAP');

      settle(problems, 'the annual-pay warning on the request form');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Each rule, driven to FAIL
// ───────────────────────────────────────────────────────────────────────────

/**
 * A rule that can only ever PASS in this environment is a rule nobody has
 * tested.
 *
 * Five of the ten are governed by a system setting, so each is forced to FAIL
 * by moving its own setting and asking the same what-if call the panel makes.
 * The flips are environment-wide — `loan_max_active_per_employee` alone
 * re-routes `loans.admin-employee.spec.ts` and `finance-loan-lifecycle.spec.ts`
 * — so the whole describe is gated on `E2E_ALLOW_FLAG_FLIP` and is still
 * COLLECTED by a default run, reporting "skipped, and here is why" rather than
 * vanishing.
 */
test.describe('every settings-governed rule can be driven to FAIL', () => {
  let apiOwner: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';

  const SKIP_REASON =
    'flips an environment-wide loan setting; run with E2E_ALLOW_FLAG_FLIP=1 against its own database';

  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'one project asks, or every flip happens four times');
    test.skip(!flagFlipAllowed(), SKIP_REASON);
  });

  test.beforeAll(async () => {
    if (!isProject('employee') || !flagFlipAllowed()) return;
    try {
      apiOwner = await ApiClient.asAccount(API_OWNER_EMAIL, API_OWNER_PASSWORD);
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await apiOwner?.dispose();
    await adminApi?.dispose();
  });

  test('MIN_SERVICE fails when the service period is raised above any tenure', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await withSetting(adminApi, 'loan_min_service_months', '600', async () => {
      const result = await eligibilityOf(apiOwner, { amount: 600, installments: 6, type: 'LOAN' });
      const rule = ruleOf(result, 'MIN_SERVICE');
      expect(rule?.status).toBe('FAIL');
      expect(Number(rule?.limit)).toBe(600);
      // A FAIL on any rule is what makes the verdict negative, and the verdict
      // is what the form draws.
      expect(result.eligible).toBe(false);
    });
  });

  test('MAX_ACTIVE_LOANS fails when the cap is dropped to zero', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await withSetting(adminApi, 'loan_max_active_per_employee', '0', async () => {
      const result = await eligibilityOf(apiOwner, { amount: 600, installments: 6, type: 'LOAN' });
      // `activeCount < maxActive` with maxActive 0 is false whatever the count
      // — a cap of zero closes the door outright, which is what a module being
      // wound down looks like.
      expect(ruleOf(result, 'MAX_ACTIVE_LOANS')?.status).toBe('FAIL');
      expect(result.eligible).toBe(false);
      await expect(
        apiOwner.post('/advance-loans', {
          type: 'LOAN',
          amount: 600,
          installments: 6,
          reason: `${MARK} — filed under a zero cap`,
        }),
      ).rejects.toThrow(/400/);
    });
  });

  test('AMOUNT_CEILING fails when the salary multiple is set below the amount', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const baseline = await eligibilityOf(apiOwner, { amount: 600, installments: 6, type: 'LOAN' });
    test.skip(!(baseline.monthlyNet > 0), 'no pay on record, so no ceiling can be computed');
    const overTheCeiling = Math.ceil(baseline.monthlyNet) + 1;

    // A multiple of 1 puts the ceiling at exactly one month's pay. Left at its
    // default of `0` the rule is switched off entirely (`ceiling === null`),
    // which is why it can never fail in an unflipped environment.
    await withSetting(adminApi, 'loan_max_amount_multiple_of_salary', '1', async () => {
      const result = await eligibilityOf(apiOwner, {
        amount: overTheCeiling,
        installments: 6,
        type: 'LOAN',
      });
      const rule = ruleOf(result, 'AMOUNT_CEILING');
      expect(rule?.status).toBe('FAIL');
      expect(Number(rule?.actual)).toBe(overTheCeiling);
      expect(result.eligible).toBe(false);
    });
  });

  test('INSTALLMENT_RANGE fails when the repayment period exceeds the configured maximum', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await withSetting(adminApi, 'advance_loan_max_installments', '2', async () => {
      const result = await eligibilityOf(apiOwner, { amount: 600, installments: 6, type: 'LOAN' });
      const rule = ruleOf(result, 'INSTALLMENT_RANGE');
      expect(rule?.status).toBe('FAIL');
      expect(Number(rule?.limit)).toBe(2);
      expect(Number(rule?.actual)).toBe(6);
      expect(result.eligible).toBe(false);
    });
  });

  test('NET_PAY_AFTER_EMI fails when the affordable share of pay is cut to one percent', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const baseline = await eligibilityOf(apiOwner, { amount: 600, installments: 6, type: 'LOAN' });
    test.skip(!(baseline.monthlyNet > 0), 'the rule is guarded on monthlyNet > 0');

    await withSetting(adminApi, 'loan_max_emi_percent_of_net', '1', async () => {
      const result = await eligibilityOf(apiOwner, {
        amount: Math.ceil(baseline.monthlyNet),
        installments: 1,
        type: 'LOAN',
      });
      const rule = ruleOf(result, 'NET_PAY_AFTER_EMI');
      expect(rule?.status).toBe('FAIL');
      // The refusal names the figure and what to do about it — "spread the loan
      // over more cycles" is actionable in a way that "not eligible" is not.
      expect(rule?.detail ?? '').toMatch(/above 1% of monthly pay/i);
      expect(result.eligible).toBe(false);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The module switch
// ───────────────────────────────────────────────────────────────────────────

/**
 * `advance_loan_enabled = false`, from the two places it has to be visible.
 *
 * It is checked TWICE in the backend — once at the top of `create()`, which
 * throws "Salary Advance & Loan module is disabled", and once as the
 * `MODULE_ENABLED` rule, which is what puts it on screen BEFORE submit. A
 * switch that only refused after submit would leave the requester filling in a
 * form for a module that is not running.
 */
test.describe('a disabled module refuses, and says so before submit', () => {
  let uiOwner: ApiClient;
  let apiOwner: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  const SKIP_REASON =
    'flips advance_loan_enabled, which the whole finance suite depends on; run with E2E_ALLOW_FLAG_FLIP=1';

  test.beforeAll(async () => {
    if (!isProject('employee') || !flagFlipAllowed()) return;
    try {
      uiOwner = await ApiClient.as('employee');
      apiOwner = await ApiClient.asAccount(API_OWNER_EMAIL, API_OWNER_PASSWORD);
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await uiOwner?.dispose();
    await apiOwner?.dispose();
    await adminApi?.dispose();
  });

  test.describe('over the API', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'one project asks, or the switch is flipped four times');
      test.skip(!flagFlipAllowed(), SKIP_REASON);
    });

    test('the endpoint refuses outright while the module is off', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await withSetting(adminApi, 'advance_loan_enabled', 'false', async () => {
        await expect(
          apiOwner.post('/advance-loans', {
            type: 'ADVANCE',
            amount: 200,
            reason: `${MARK} — filed with the module off`,
          }),
        ).rejects.toThrow(/400/);

        const result = await eligibilityOf(apiOwner, { amount: 200, type: 'ADVANCE' });
        expect(ruleOf(result, 'MODULE_ENABLED')?.status).toBe('FAIL');
        expect(result.eligible).toBe(false);
      });
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the request form belongs to the requester');
      test.skip(!flagFlipAllowed(), SKIP_REASON);
    });

    test('the form shows MODULE_ENABLED failing and files nothing', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // Judged crashes-only: submitting against a disabled module IS a 400, and
      // the browser logs every 4xx as a console error. An uncaught render or a
      // 5xx never is, and those stay fatal.
      crashesOnly(problems);

      const reason = `${MARK} — form against a disabled module`;
      await withSetting(adminApi, 'advance_loan_enabled', 'false', async () => {
        await selectBranch(page, branchId);
        const modal = await openCreateForm(page, { type: 'ADVANCE', amount: '200', reason });

        const row = page.getByTestId('loan-eligibility-check-MODULE_ENABLED');
        await expect(row).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => row.getAttribute('data-status'), { timeout: 15_000 }).toBe('FAIL');
        await expect
          .poll(
            () => page.getByTestId('loan-eligibility-verdict').getAttribute('data-eligible'),
            { timeout: 15_000 },
          )
          .toBe('false');

        // The panel does not disable the button — the server is still the one
        // that refuses, and the refusal has to survive the trip back. Waiting
        // for the toast is what orders the two assertions below AFTER the round
        // trip; reading them straight off the click would pass on a form that
        // was merely slow to close.
        await modal.getByTestId('loan-submit').click();
        const refusal = await new ToastArea(page).waitFor('error');
        expect(refusal, 'the module switch refused without saying so').toMatch(/disabled/i);

        expect(await modal.isVisible(), 'a refused submit closed its own form').toBe(true);
        expect((await mineWith(uiOwner, reason)).length, 'a request was filed with the module off')
          .toBe(0);
      });

      settle(problems, 'the request form while the loan module is disabled');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Who the employee record says may borrow
// ───────────────────────────────────────────────────────────────────────────

/**
 * Two rules that depend on the EMPLOYEE rather than on any setting, so they
 * need employees this file owns.
 *
 * Asked as ADMIN about a specific `employeeId`, which the controller allows
 * only for ADMIN/HR_MANAGER/MANAGER — a requester is silently forced back onto
 * their own record, which is a different assertion and belongs elsewhere.
 */
test.describe('an employee record can rule out borrowing on its own', () => {
  let adminApi: ApiClient;
  let terminatedId = '';
  let futureStarterId = '';
  let setupError = '';

  /** 90 days out — inside `employee_start_date_max_future_days` (180). */
  const futureStart = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'one project asks, or four employees are minted per run');
  });

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      adminApi = await ApiClient.as('admin');

      // DISTINCT markers, not one shared with the rest of the file:
      // `makeEmployee` derives the login address from the marker
      // (`<slug>@e2e.local`), so two employees minted from the same one collide
      // on a unique email and the second create is a 400.
      const leaver = await makeEmployee(adminApi, {
        marker: `${MARK}-leaver`,
        baseSalary: 30000,
        startDate: '2020-01-01',
      });
      terminatedId = leaver.id;
      // A SOFT delete: status becomes INACTIVE (R72) and `endDate` is stamped
      // `now()`, which is what puts a request dated today after the last
      // working day.
      await terminateEmployee(adminApi, terminatedId);

      const joiner = await makeEmployee(adminApi, {
        marker: `${MARK}-joiner`,
        baseSalary: 30000,
        startDate: futureStart,
      });
      futureStarterId = joiner.id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    // The leaver is already gone; the joiner would otherwise stay on the books
    // as an active employee nobody employs.
    if (isProject('employee') && futureStarterId) {
      await terminateEmployee(adminApi, futureStarterId).catch(() => undefined);
    }
    await adminApi?.dispose();
  });

  test('a terminated employee cannot take a new loan', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    test.skip(!terminatedId, 'no terminated employee was minted');

    const result = await eligibilityOf(adminApi, {
      employeeId: terminatedId,
      amount: 600,
      installments: 6,
      type: 'LOAN',
    });

    // Two rules, not one, and they are not redundant: EMPLOYEE_ACTIVE is about
    // the status, NOT_AFTER_RESIGNATION is about the DATE — an employee serving
    // notice is still ACTIVE and already has a last working day.
    expect(ruleOf(result, 'EMPLOYEE_ACTIVE')?.status).toBe('FAIL');
    expect(ruleOf(result, 'NOT_AFTER_RESIGNATION')?.status).toBe('FAIL');
    expect(result.eligible).toBe(false);
  });

  test('an employee who has not started yet cannot take a loan', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    test.skip(!futureStarterId, 'no future starter was minted');

    const result = await eligibilityOf(adminApi, {
      employeeId: futureStarterId,
      amount: 600,
      installments: 6,
      type: 'LOAN',
    });

    // `evaluate` dates the request TODAY when no start date is supplied, so a
    // joining date in the future puts the request before the employment.
    const rule = ruleOf(result, 'NOT_BEFORE_JOINING');
    expect(rule?.status).toBe('FAIL');
    expect(String(rule?.limit)).toBe(futureStart);
    expect(result.eligible).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The what-if endpoint judges its own payload
// ───────────────────────────────────────────────────────────────────────────

/**
 * `EligibilityCheckDto`, which is bounded DIFFERENTLY from
 * `CreateAdvanceLoanDto` next to it.
 *
 * That divergence is the reason these cases exist rather than being folded into
 * the create ones: the what-if door bounds decimal places, has a hard `@Max` on
 * the amount and allows ten times as many instalments (600 against 60). A test
 * that assumed the two doors agreed would be asserting a symmetry the code does
 * not have.
 */
test.describe('the eligibility endpoint judges its own payload', () => {
  let apiOwner: ApiClient;
  let setupError = '';

  const ask = (payload: Record<string, unknown>) =>
    apiOwner.post('/advance-loans/eligibility', payload);

  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'one project asks, or the same 400 is proved four times');
  });

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      apiOwner = await ApiClient.asAccount(API_OWNER_EMAIL, API_OWNER_PASSWORD);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await apiOwner?.dispose();
  });

  test('an amount of zero is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@Min(0.01)` — a what-if about nothing is not a question the engine can
    // answer usefully.
    await expect(ask({ amount: 0, installments: 6, type: 'LOAN' })).rejects.toThrow(/400/);
  });

  test('the largest representable amount is accepted', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // `@Max(9999999999.99)`, which is exactly what a `Decimal(12,2)` column can
    // hold. Accepted is not the same as eligible — the engine answers, and the
    // answer is almost certainly "no".
    const result = await eligibilityOf(apiOwner, {
      amount: 9999999999.99,
      installments: 6,
      type: 'LOAN',
    });
    expect(Array.isArray(result.checks), 'the boundary amount produced no rules').toBe(true);
    expect(typeof result.eligible).toBe('boolean');
  });

  test('one unit above the largest representable amount is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    await expect(ask({ amount: 10000000000, installments: 6, type: 'LOAN' })).rejects.toThrow(/400/);
  });

  test('six hundred and one instalments are refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@Max(600)` here against `@Max(60)` on the create DTO — the what-if door
    // is deliberately the wider of the two.
    await expect(ask({ amount: 600, installments: 601, type: 'LOAN' })).rejects.toThrow(/400/);
  });

  test('an employee id that is not a UUID is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // `@IsUUID()` runs in the pipe, BEFORE the controller decides that a
    // non-privileged caller may only ask about themselves — so a requester
    // gets a 400 here rather than a silent answer about their own record.
    await expect(
      ask({ employeeId: 'not-a-uuid', amount: 600, installments: 6, type: 'LOAN' }),
    ).rejects.toThrow(/400/);
  });
});
