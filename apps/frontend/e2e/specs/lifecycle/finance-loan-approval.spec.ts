import type { Page } from '@playwright/test';
import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, ToastArea, selectBranch } from '../../pages';
import { LoanLifecyclePage } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  ensureAllowance,
  flagFlipAllowed,
  loanOf,
  makeEmployee,
  marker,
  retire,
  retireAllMarked,
  scheduleOf,
  terminateEmployee,
  withSetting,
  withSettings,
} from '../../loan-support';

/**
 * THE DECISION — everything that happens between "a request exists" and "a
 * request has been decided".
 *
 * `loans.admin-employee.spec.ts` establishes the happy path: an approver types
 * a number into the review modal, the record carries that number, and a
 * schedule of that length exists. `finance-loan-lifecycle.spec.ts` picks the
 * loan up afterwards, once money is moving. This file is the gap between them,
 * and it is where the money is actually committed — approval is the step that
 * fixes the repayment period, computes the instalment, writes the amortization
 * plan and stamps the disbursement. Nothing before it is binding and nothing
 * after it can be un-decided.
 *
 * ## Why the refusals matter more than the approvals here
 *
 * The approval path has exactly one shape and it is already covered. What is
 * NOT covered, and what this file is for, is every way a decision must be
 * refused:
 *
 *   • **Twice.** Two approvers on the same request would each write their own
 *     schedule; `decide()` guards on `status !== 'PENDING'` and `applyApproved`
 *     guards again with a conditional `updateMany`. Four orderings are asserted
 *     (approve→approve, approve→reject, reject→approve, cancel→approve),
 *     because a guard that only covered the first is a guard that only covers
 *     the case somebody thought of.
 *
 *   • **By the wrong role.** Who may approve comes from the
 *     `advance_loan_approver_roles` SETTING read at request time, not from the
 *     `@Roles()` decorator on the route — the decorator admits MANAGER, and the
 *     pinned setting does not. Both gates are asserted from both sides, and the
 *     MANAGER case has a second gate on top (`isDeptInManagerScope`) that the
 *     setting alone would not give.
 *
 *   • **Before it leaves the browser.** Two of the review modal's refusals are
 *     answered client-side, and one of those turns out to be answered by the
 *     BROWSER rather than by the app at all — see the `// BUG?:` notes.
 *     Those cases assert that no request was made, because a guard that quietly
 *     stopped guarding would otherwise still look green.
 *
 * ## The one rule that does not exist, which is the file's main finding
 *
 * There is NO self-approval rule. `assertApprover` checks the role and the
 * MANAGER's department scope and nothing else; `decide` never compares the
 * approver to the requester. `loans.admin-employee.spec.ts` says as much in
 * passing ("there is no separate 'not your own request' rule to lean on") and
 * concludes it does not matter because an EMPLOYEE is not an approver anyway.
 * That reasoning holds for an EMPLOYEE and fails for an HR_MANAGER, who is both
 * a requester and an approver — and whose own request appears in their own
 * queue with a live Approve button on it. The case is written to assert what
 * happens today, marked, and left for somebody to decide about.
 *
 * ## The allowance discipline
 *
 * `loan_max_active_per_employee` is **2**, and five loan spec files share four
 * seeded accounts. Every loan created here is retired the moment its test is
 * done, `ensureAllowance` sweeps this file's OWN leftovers first (they all
 * carry `MARKER_PREFIX` in their reason), and `retireAllMarked` collects
 * stragglers from a crashed earlier run in `afterAll`. See `loan-support.ts`
 * for why the two-pass sweep is not optional.
 *
 * ## Who this file borrows, and from whom
 *
 * Deliberately spread, because the projects are different workers and can run
 * these describes concurrently:
 *
 *   employee1  the admin review-modal suite, and its own cancel suite
 *   hr manager the approver-side gates, on their own record
 *   manager2   everything MANAGER-scoped, plus the two destructive cases — the
 *              loggable account with the fewest other readers
 *
 * ⚠ manager2 is NOT unread: `finance-loan-data-integrity.spec.ts` logs in as it
 * too. Terminating it here therefore has to be undone COMPLETELY — the soft
 * delete deactivates the LOGIN as well as the employee, and only
 * `PATCH /users/:id { isActive: true }` puts that half back. See
 * `restoreSeededAccount` and the doc on the termination case itself.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The stable half of the marker — what identifies a loan as THIS FILE'S across
 * runs. `marker()` adds a per-run suffix on top, so a leftover can be dated as
 * well as owned. Both sweeps match on the PREFIX, never on the full mark.
 */
const MARKER_PREFIX = 'pw-loanapprove-';

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const MARK = marker(MARKER_PREFIX);

const reasonFor = (note: string) => `${MARK} — ${note}`;

/**
 * Every describe that writes a `SystemSetting` is gated on this.
 *
 * `withSetting`/`withSettings` REFUSE to run without `E2E_ALLOW_FLAG_FLIP=1`
 * (they throw rather than silently proceeding), because a setting is shared
 * with every parallel worker: flipping `advance_loan_approver_roles` re-routes
 * the approve buttons `loans.admin-employee.spec.ts` presses, and the failure
 * lands in a file that never touched the flag. Same convention and the same
 * variable as `approval-chain.spec.ts`.
 */
const FLAG_SKIP =
  'changes environment-wide configuration; run with E2E_ALLOW_FLAG_FLIP=1 against its own database';

const HRD_MANAGER_EMAIL = 'manager@company.com';
const OPS_MANAGER_EMAIL = 'manager2@company.com';
const SEEDED_PASSWORD = 'Password123!';

// ───────────────────────────────────────────────────────────────────────────
// Small readers, kept here rather than in loan-support because they are this
// file's business and nothing else's.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rows out of whichever envelope they arrived in.
 *
 * Three shapes are in play across the endpoints this file reads: a bare array
 * (`GET /branches`), `{ data, meta }` after `ApiClient` has peeled the outer
 * `{ success, data }` (`GET /advance-loans?page=`), and a doubly-wrapped
 * `{ success, data }` from a service that builds its own envelope on top of the
 * global interceptor's (`GET /advance-loans/reports/...`). Depending on which
 * one a route happens to use today is how a spec breaks for a reason that has
 * nothing to do with its subject.
 */
function rowsOf<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const inner = (raw as { data?: unknown } | null)?.data;
  if (Array.isArray(inner)) return inner as T[];
  const deeper = (inner as { data?: unknown } | null)?.data;
  return Array.isArray(deeper) ? (deeper as T[]) : [];
}

/** The loan's machine status, polled rather than read once. */
async function statusOf(api: ApiClient, id: string): Promise<string> {
  return String((await loanOf(api, id)).status ?? '');
}

/**
 * One setting's effective value, defaults included.
 *
 * Read rather than assumed because the assertion below quotes it back:
 * `advance_loan_max_installments` is NOT pinned by the e2e baseline, so the 12
 * this file would otherwise hardcode is the server's default rather than a fact
 * about the database under test.
 */
async function settingValue(admin: ApiClient, key: string, fallback: string): Promise<string> {
  const raw = await admin.get<unknown>('/system-settings').catch(() => []);
  const row = rowsOf<{ key: string; value: string }>(raw).find((r) => r.key === key);
  return row?.value ?? fallback;
}

/** An employee id from the seeded account's code, for the destructive cases. */
async function employeeIdByCode(admin: ApiClient, code: string): Promise<string> {
  const raw = await admin.get<unknown>(`/employees?search=${encodeURIComponent(code)}&limit=10`);
  const hit = rowsOf<{ id: string; employeeCode: string }>(raw).find(
    (e) => e.employeeCode === code,
  );
  if (!hit) throw new Error(`No employee with code ${code} — the baseline seed did not run`);
  return hit.id;
}

/**
 * The LOGIN row behind a seeded address.
 *
 * `GET /users?search=` filters with `email: { contains }`, so the exact address
 * is matched here rather than trusting the first row back — `manager@` is a
 * prefix of nothing, but `employee1@` is one keystroke from `employee10@` and
 * the same helper will be copied.
 *
 * Deliberately does NOT filter on `isActive`: this is called precisely when the
 * account has been deactivated and needs finding again.
 */
async function userIdByEmail(admin: ApiClient, email: string): Promise<string | undefined> {
  const raw = await admin
    .get<unknown>(`/users?search=${encodeURIComponent(email)}&limit=10`)
    .catch(() => undefined);
  return rowsOf<{ id: string; email: string }>(raw).find((u) => u.email === email)?.id;
}

/**
 * ⚠ Puts a soft-deleted SEEDED account back — BOTH halves of it.
 *
 * `DELETE /employees/:id` is a soft delete that writes TWO rows, and this is the
 * bug that made it worth a helper: `EmployeesService.delete()` sets
 * `Employee.status = 'INACTIVE'` AND, in the same transaction,
 * `User.isActive = false` on the linked login. `PATCH /employees/:id` has no
 * user-side effect whatsoever — it writes the Employee row and nothing else — so
 * restoring `status: 'ACTIVE'` and clearing `endDate` puts the PERSON back while
 * leaving the LOGIN dead. `AuthService` refuses an inactive user, so from that
 * point on every later spec that calls `ApiClient.asAccount(email, …)` fails at
 * setup with a 401 that names a file which never touched this account.
 *
 * The login IS restorable over the API: `PATCH /users/:id { isActive: true }`
 * (ADMIN only) writes the DTO straight through. That is the second half here,
 * and it is the half nobody remembers.
 *
 * Idempotent and never throws — it is called from a `finally` and again from
 * `afterAll`, and a teardown that throws would mask the real failure.
 */
async function restoreSeededAccount(
  admin: ApiClient,
  employeeId: string,
  email: string,
): Promise<void> {
  if (employeeId) {
    await admin
      .patch(`/employees/${employeeId}`, { status: 'ACTIVE', endDate: null })
      .catch(() =>
        admin.patch(`/employees/${employeeId}`, {
          status: 'ACTIVE',
          endDate: '2099-12-31',
        }),
      )
      .catch(() => undefined);
  }

  const userId = await userIdByEmail(admin, email).catch(() => undefined);
  if (userId) {
    await admin.patch(`/users/${userId}`, { isActive: true }).catch(() => undefined);
  }
}

interface StatementLoan {
  id: string;
  transactions?: Array<{ type: string; amount: number | string }>;
}

/** The only route that exposes `LoanTransaction` rows to a client. */
async function statementLoan(
  admin: ApiClient,
  employeeId: string,
  loanId: string,
): Promise<StatementLoan | undefined> {
  const raw = await admin.get<unknown>(
    `/advance-loans/reports/employee/${employeeId}/statement`,
  );
  return rowsOf<StatementLoan>(raw).find((l) => l.id === loanId);
}

/**
 * Files a PENDING request over the API.
 *
 * Deliberately NOT `liveLoan` — that helper approves what it files, and the
 * decision is precisely this file's subject. The allowance sweep is the same
 * one, run with this file's own prefix so it collects its own leftovers before
 * it will touch anything another spec is halfway through.
 */
async function filePending(
  owner: ApiClient,
  admin: ApiClient,
  opts: { type?: 'ADVANCE' | 'LOAN'; amount: number; installments?: number; note: string },
): Promise<string> {
  const type = opts.type ?? 'LOAN';
  await ensureAllowance(owner, admin, opts.amount, MARKER_PREFIX);
  const created = await owner.post<{ id: string }>('/advance-loans', {
    type,
    amount: opts.amount,
    installments: type === 'LOAN' ? (opts.installments ?? 6) : undefined,
    reason: reasonFor(opts.note),
  });
  return created.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Driving the review modal
// ───────────────────────────────────────────────────────────────────────────

/**
 * Opens the row-level review dialog and proves it is the one that was asked
 * for.
 *
 * `AdvanceLoansPage.approve()` / `.reject()` exist for the cases that go
 * through; these cases need the dialog left OPEN so a refusal can be observed,
 * so the steps are taken one at a time here. `data-review-action` is asserted
 * because one component renders both dialogs and the difference between them is
 * an attribute, not a screen.
 */
async function openReview(
  page: Page,
  loans: AdvanceLoansPage,
  loanId: string,
  action: 'approve' | 'reject',
) {
  await loans.row(loanId).getByTestId(`loan-${action}`).click();
  const modal = page.getByTestId('loan-review-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('data-review-action', action);
  return modal;
}

/**
 * Records every request the page makes to a matching URL.
 *
 * `problems.httpErrors` only carries NON-2xx responses, so "no 4xx was logged"
 * is not the same claim as "nothing was sent" — a client guard that stopped
 * guarding would let a perfectly successful POST through and leave
 * `httpErrors` empty. The cases that assert a refusal never left the browser
 * assert both.
 */
function watchRequests(page: Page, re: RegExp): string[] {
  const seen: string[] = [];
  page.on('request', (req) => {
    if (re.test(req.url())) seen.push(`${req.method()} ${req.url()}`);
  });
  return seen;
}

// ═══════════════════════════════════════════════════════════════════════════
// The review modal, from the approver's queue
// ═══════════════════════════════════════════════════════════════════════════

test.describe('the approval decision, through the review modal', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let maxInstallments = 12;

  /** Loans this test created, retired as soon as it finishes. */
  let scratch: string[] = [];

  const track = async (opts: Parameters<typeof filePending>[2]): Promise<string> => {
    const id = await filePending(employeeApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
      maxInstallments = Number(
        await settingValue(adminApi, 'advance_loan_max_installments', '12'),
      );
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, employeeApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the approver queue is an ADMIN/HR surface');
    });

    test('an overridden repayment period rewrites the terms, the instalment and the plan', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'modal approval' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'approve');
      await modal.getByTestId('loan-review-installments').fill('4');
      await modal.getByTestId('loan-review-note').fill(reasonFor('four cycles is affordable'));
      await modal.getByTestId('loan-review-submit').click();
      await modal.waitFor({ state: 'detached', timeout: 20_000 });

      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      // The three facts that have to agree. A record that says APPROVED while
      // carrying the requester's six instalments has silently changed what the
      // employee owes each month, and the button reacted either way.
      const record = await loanOf(adminApi, id);
      expect(record.installments, "the approver's override never reached the record").toBe(4);
      expect(Number(record.installmentAmount)).toBe(600 / 4);
      expect(record.approverRemarks).toContain(MARK);

      // The plan is what payroll recovers against; APPROVED with an empty
      // schedule is a debt nobody will ever collect.
      await expect
        .poll(async () => (await scheduleOf(adminApi, id)).length, { timeout: 15_000 })
        .toBe(4);

      settle(problems, 'approving a loan from the review modal');
    });

    test('approving without touching the period keeps the count the requester asked for', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 900, installments: 3, note: 'no override' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'approve');

      // The answer to "which fallback?" is visible before submit: the field is
      // pre-filled from the REQUEST, not from a hardcoded default, so an
      // approver who agrees with the requester simply presses the button. (The
      // component's own `|| 3` only applies to a request carrying no count at
      // all, which the create form does not allow for a LOAN.)
      expect(
        await modal.getByTestId('loan-review-installments').inputValue(),
        'the review modal did not open on the count the requester asked for',
      ).toBe('3');

      await modal.getByTestId('loan-review-note').fill(reasonFor('as requested'));
      await modal.getByTestId('loan-review-submit').click();
      await modal.waitFor({ state: 'detached', timeout: 20_000 });

      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      const record = await loanOf(adminApi, id);
      expect(record.installments).toBe(3);
      expect(Number(record.installmentAmount)).toBe(900 / 3);

      settle(problems, 'approving without an override');
    });

    test('an ADVANCE is approved in one deduction, and the modal never offers a period', async ({
      page,
      problems,
    }) => {
      const id = await track({ type: 'ADVANCE', amount: 200, note: 'advance approval' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'approve');
      // An advance is recovered in a single cycle, so there is no period to
      // set. The field is not disabled or defaulted — it does not exist, which
      // is the only version of this that cannot be got wrong by an approver.
      expect(
        await modal.getByTestId('loan-review-installments').count(),
        'the advance review offered a repayment period',
      ).toBe(0);

      await modal.getByTestId('loan-review-note').fill(reasonFor('advance approved'));
      await modal.getByTestId('loan-review-submit').click();
      await modal.waitFor({ state: 'detached', timeout: 20_000 });

      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      const record = await loanOf(adminApi, id);
      expect(record.installments).toBe(1);
      expect(Number(record.installmentAmount)).toBe(200);
      await expect
        .poll(async () => (await scheduleOf(adminApi, id)).length, { timeout: 15_000 })
        .toBe(1);

      settle(problems, 'approving a salary advance');
    });

    test('the API forces an advance to one instalment however many it is sent', async () => {
      test.skip(!isProject('admin'), 'the rule, not the screen');
      const id = await track({ type: 'ADVANCE', amount: 200, note: 'advance forced to one' });

      // A hidden field is a UI decision; this is the rule. Without it the
      // single-deduction guarantee is one `curl` away from irrelevant, and a
      // six-cycle "advance" would carry a schedule the recovery planner has no
      // policy for.
      await adminApi.post(`/advance-loans/${id}/approve`, {
        remarks: reasonFor('six were asked for'),
        installments: 6,
      });

      const record = await loanOf(adminApi, id);
      expect(record.status).toBe('APPROVED');
      expect(record.installments, 'an advance was spread over more than one cycle').toBe(1);
      expect(Number(record.installmentAmount)).toBe(200);
      expect((await scheduleOf(adminApi, id)).length).toBe(1);
    });

    test('a blank repayment period is refused in the browser and never reaches the server', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'blank period' });

      await selectBranch(page, branchId);
      const sent = watchRequests(page, /\/advance-loans\/[^/]+\/approve/);
      const loans = new AdvanceLoansPage(page);
      const toasts = new ToastArea(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'approve');
      await modal.getByTestId('loan-review-installments').fill('');
      await modal.getByTestId('loan-review-submit').click();

      // The app's own sentence, quoting the configured maximum rather than a
      // generic "invalid input" — the approver can act on this one.
      const text = await toasts.waitFor('warning');
      expect(text).toContain(`Enter a repayment period between 1 and ${maxInstallments} installments`);

      // Two independent proofs that it stopped here: nothing was sent, and no
      // non-2xx was logged. The first is the real claim; the second is what a
      // reader would otherwise have to take on trust.
      expect(sent, 'the blank-period guard let the request through to the server').toEqual([]);
      expect(
        problems.httpErrors.filter((line) => line.includes('/approve')),
        'the server answered an approval that should never have been sent',
      ).toEqual([]);

      // A refusal is a refusal: the dialog stays open, carrying what was typed,
      // so the period can be corrected rather than retyped.
      await expect(modal).toBeVisible();
      expect(await statusOf(adminApi, id)).toBe('PENDING');

      settle(problems, 'a blank repayment period');
    });

    test('a repayment period above the maximum is stopped by the app, not the browser', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'over-max period' });

      await selectBranch(page, branchId);
      const sent = watchRequests(page, /\/advance-loans\/[^/]+\/approve/);
      const loans = new AdvanceLoansPage(page);
      const toasts = new ToastArea(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'approve');
      await modal.getByTestId('loan-review-installments').fill(String(maxInstallments + 1));
      await modal.getByTestId('loan-review-submit').click();

      // Give any request — and any toast — time to appear. Absence cannot be
      // polled for; a fixed pause is the honest way to assert it.
      await page.waitForTimeout(1_500);

      // The review form carries `noValidate`, so `handleReviewSubmit` runs its
      // own range guard and the approver gets the app's sentence rather than a
      // native bubble in the browser's language. `max` stays on the field for
      // its semantics; it no longer pre-empts the app.
      expect(
        (await toasts.latest())?.text,
        'the app did not state its own range refusal',
      ).toBe(`Enter a repayment period between 1 and ${maxInstallments} installments`);

      // The claim that matters is unchanged: an out-of-range period never
      // becomes a schedule, and never leaves the browser to try.
      expect(sent, 'an out-of-range repayment period reached the server').toEqual([]);
      await expect(modal).toBeVisible();
      expect(await statusOf(adminApi, id)).toBe('PENDING');

      settle(problems, 'a repayment period above the maximum');
    });

    test('a rejection without a reason never leaves the browser', async ({ page, problems }) => {
      const id = await track({ amount: 600, installments: 6, note: 'reasonless rejection' });

      await selectBranch(page, branchId);
      const sent = watchRequests(page, /\/advance-loans\/[^/]+\/reject/);
      const loans = new AdvanceLoansPage(page);
      const toasts = new ToastArea(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'reject');
      await modal.getByTestId('loan-review-submit').click();
      await page.waitForTimeout(1_500);

      // The form is `noValidate`, so an EMPTY reason reaches the app's own
      // guard and gets the app's own sentence. `required` stays on the textarea
      // for its semantics; it no longer pre-empts the app, which used to leave
      // the user with a native bubble in the browser's language instead.
      expect(
        (await toasts.latest())?.text,
        'the app did not state its own reason refusal',
      ).toBe('Please enter a reason for rejection');
      expect(sent, 'a reasonless rejection reached the server').toEqual([]);
      await expect(modal).toBeVisible();

      // Whitespace SATISFIES `required` and is what actually reaches the app's
      // guard — which trims before it judges. This is the path on which the
      // app's own sentence is observable at all.
      await modal.getByTestId('loan-review-note').fill('    ');
      await modal.getByTestId('loan-review-submit').click();

      const text = await toasts.waitFor('warning');
      expect(text).toContain('Please enter a reason for rejection');
      expect(sent, 'a whitespace rejection reached the server').toEqual([]);
      expect(
        problems.httpErrors.filter((line) => line.includes('/reject')),
        'the server answered a rejection that should never have been sent',
      ).toEqual([]);

      await expect(modal).toBeVisible();
      expect(await statusOf(adminApi, id)).toBe('PENDING');

      settle(problems, 'a rejection with no reason');
    });

    test('a rejected request keeps its reason, and its own page says so', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'rejection' });
      const why = reasonFor('the employee already carries two live loans');

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      const modal = await openReview(page, loans, id, 'reject');
      await modal.getByTestId('loan-review-note').fill(why);
      await modal.getByTestId('loan-review-submit').click();
      await modal.waitFor({ state: 'detached', timeout: 20_000 });

      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('REJECTED');

      // The reason typed into the dialog is the reason the record carries. A
      // rejection the requester cannot read the reason for is a rejection they
      // will file again next week.
      const record = await loanOf(adminApi, id);
      expect(record.rejectedReason, 'the rejection reason never reached the record').toBe(why);
      expect(record.installmentAmount, 'a refused request was given repayment terms').toBeFalsy();

      // And it survives to the screen the requester actually opens.
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('REJECTED');
      expect(
        await detail.hasRejectedBanner(),
        'a rejected request showed no explanation on its own page',
      ).toBe(true);

      settle(problems, 'rejecting a loan request');
    });

    test('a decided request leaves the queue and cannot be decided a second time', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'double decision' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      await loans.approve(id, { installments: 6, note: reasonFor('first decision') });
      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      // Out of the queue, which is the only reason a second approver would not
      // reach for it in the first place.
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.hasRow(id), { timeout: 15_000 }).toBe(false);

      // And refused when asked directly, which is what stops two approvers
      // racing from each writing their own schedule.
      await expect(
        adminApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('second approval'),
          installments: 2,
        }),
      ).rejects.toThrow(/already approved/i);

      await expect(
        adminApi.post(`/advance-loans/${id}/reject`, { remarks: reasonFor('too late') }),
      ).rejects.toThrow(/already approved/i);

      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('APPROVED');
      expect(after.installments, 'a refused second decision rewrote the terms anyway').toBe(6);

      settle(problems, 'the queue after a decision');
    });

    test('a rejected request cannot then be approved', async () => {
      test.skip(!isProject('admin'), 'the rule, not the screen');
      const id = await track({ amount: 500, installments: 5, note: 'reject then approve' });

      await adminApi.post(`/advance-loans/${id}/reject`, { remarks: reasonFor('refused') });
      expect(await statusOf(adminApi, id)).toBe('REJECTED');

      await expect(
        adminApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('reconsidered'),
          installments: 5,
        }),
      ).rejects.toThrow(/already rejected/i);

      // Reversing a rejection is a NEW request, not an edit of the old one —
      // the alternative is a record whose history says two contradictory
      // things.
      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('REJECTED');
      expect(after.installmentAmount).toBeFalsy();
    });

    test('a cancelled request cannot then be approved', async () => {
      test.skip(!isProject('admin'), 'the rule, not the screen');
      const id = await track({ amount: 500, installments: 5, note: 'cancel then approve' });

      await employeeApi.delete(`/advance-loans/${id}`);
      expect(await statusOf(adminApi, id)).toBe('CANCELLED');

      await expect(
        adminApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('approving a withdrawn request'),
          installments: 5,
        }),
      ).rejects.toThrow(/already cancelled/i);

      expect(await statusOf(adminApi, id)).toBe('CANCELLED');
    });

    test('cancelling belongs to the requester, and only while the request is pending', async () => {
      test.skip(!isProject('admin'), 'the rule, not the screen');
      const id = await track({ amount: 500, installments: 5, note: 'cancel ownership' });

      // The route admits ADMIN — `@Roles('ADMIN','HR_MANAGER','MANAGER','EMPLOYEE')` —
      // and the service still refuses, because withdrawing somebody's request
      // on their behalf is not an administrative act. That gap is the whole
      // point: a test that only checked the decorator would call this covered.
      await expect(adminApi.delete(`/advance-loans/${id}`)).rejects.toThrow(/403|permission/i);
      expect(await statusOf(adminApi, id)).toBe('PENDING');

      await adminApi.post(`/advance-loans/${id}/approve`, {
        remarks: reasonFor('approved before the withdrawal'),
        installments: 5,
      });
      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      // Once the money is committed, withdrawing is not the owner's to do
      // either — a schedule exists and payroll may already have claimed it.
      await expect(employeeApi.delete(`/advance-loans/${id}`)).rejects.toThrow(
        /400|Only pending/i,
      );
      expect(await statusOf(adminApi, id)).toBe('APPROVED');
    });

    test('approval writes the disbursement, the plan and the dates payroll needs', async () => {
      test.skip(!isProject('admin'), 'the side effects, which have no screen of their own');
      const id = await track({ amount: 600, installments: 6, note: 'disbursement side effects' });

      await adminApi.post(`/advance-loans/${id}/approve`, {
        remarks: reasonFor('disbursed on approval'),
        installments: 6,
      });
      await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');

      const record = await loanOf(adminApi, id);

      // There is NO disburse step. `applyApproved` writes the DISBURSEMENT
      // transaction itself, so `DISBURSED` is a status the enum carries and the
      // approval path never produces — a spec waiting for it would wait
      // forever, and a reader looking for the step that produces it would not
      // find one.
      expect(record.status, 'approval produced a status other than APPROVED').toBe('APPROVED');
      expect(Number(record.disbursedAmount), 'nothing was recorded as paid out').toBe(600);
      expect(
        record.firstDeductionDate,
        'no first deduction date, so recovery has no cycle to start in',
      ).toBeTruthy();

      const schedule = await scheduleOf(adminApi, id);
      expect(schedule.length).toBe(6);
      expect(schedule[0].dueDate).toBeTruthy();

      // The ledger side. `LoanTransaction` is reachable only through the
      // statement report — the detail route includes `deductions` (what payroll
      // recovered) and not `transactions` (what moved), which is why this
      // assertion goes the long way round.
      const employeeId = String(record.employeeId);
      const fromStatement = await statementLoan(adminApi, employeeId, id);
      expect(fromStatement, 'the approved loan is missing from its own statement').toBeTruthy();
      const disbursements = (fromStatement?.transactions ?? []).filter(
        (t) => t.type === 'DISBURSEMENT',
      );
      expect(disbursements.length, 'approval wrote no DISBURSEMENT transaction').toBe(1);
      expect(Number(disbursements[0].amount)).toBe(600);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The requester's side of a decision
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What the person who filed the request can and cannot do to it.
 *
 * Runs as the EMPLOYEE project because both claims are about a session that is
 * NOT an approver's: the Cancel control is drawn on `employeeId === user.employeeId`
 * alone, and the approver queue is drawn on membership of
 * `advance_loan_approver_roles`. Neither is observable from an admin window.
 */
test.describe('the requester cancels, and cannot approve', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  const track = async (opts: Parameters<typeof filePending>[2]): Promise<string> => {
    const id = await filePending(employeeApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('employee')) return;
    for (const id of scratch) await retire(id, employeeApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the requester half of the decision');
    });

    test('a pending request is withdrawn from the requester\'s own list', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 450, installments: 3, note: 'requester cancel' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('my');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      // Withdrawal goes through the shared ConfirmModal rather than happening
      // on the click — it is irreversible, and the request cannot be re-filed
      // without spending the allowance again.
      await loans.row(id).getByTestId('loan-cancel').click();
      const confirm = page.getByTestId('confirm-modal-confirm');
      await confirm.waitFor({ state: 'visible', timeout: 10_000 });
      await confirm.click();

      await expect.poll(() => statusOf(employeeApi, id), { timeout: 15_000 }).toBe('CANCELLED');

      // CANCELLED is terminal, so the allowance is released — which is the
      // practical reason a requester cancels rather than leaving it pending.
      const record = await loanOf(employeeApi, id);
      expect(record.installmentAmount, 'a withdrawn request was given repayment terms').toBeFalsy();

      settle(problems, 'withdrawing a pending request');
    });

    test('an EMPLOYEE is offered no queue, and the API refuses their approval', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 450, installments: 3, note: 'employee cannot approve' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('my');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');

      // The tab is derived from `advance_loan_approver_roles`, which an
      // EMPLOYEE is not in — so the queue does not exist for them rather than
      // existing and being empty.
      expect(
        await page.getByTestId('loan-tab-pending').count(),
        'a non-approver was offered the approval queue',
      ).toBe(0);
      expect(
        await loans.canApprove(id),
        'an employee was offered the approval control on their own request',
      ).toBe(false);

      // The route's decorator does not admit EMPLOYEE at all, so this one is
      // refused before the settings-driven gate is even consulted.
      await expect(
        employeeApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('approving my own'),
          installments: 3,
        }),
      ).rejects.toThrow(/403|Forbidden/i);

      expect(await statusOf(employeeApi, id)).toBe('PENDING');

      settle(problems, 'the requester view of a pending request');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HR_MANAGER: the second configured approver, and their own request
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The HR half of `advance_loan_approver_roles`, on HR's OWN record.
 *
 * Their own record on purpose, twice over: it keeps this describe from
 * contending with the admin suite running in a parallel worker, and it is the
 * only way to reach the self-approval case at all — an approver who is also a
 * requester is a shape only HR and MANAGER can be in.
 */
test.describe('an HR_MANAGER decides, including on their own request', () => {
  let hrApi: ApiClient;
  let adminApi: ApiClient;
  /** A requester who is NOT the approver — see `trackOther`. */
  let otherApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  /** Files as HR themselves — the self-approval case, and only that case. */
  const track = async (opts: Parameters<typeof filePending>[2]): Promise<string> => {
    const id = await filePending(hrApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  /**
   * Files as somebody else, so HR has something they are actually allowed to
   * decide. Since self-approval was closed, `findPending` excludes the caller's
   * own requests — an HR-filed request is invisible in HR's own queue, so the
   * ordinary approval path needs a requester who is not the approver.
   */
  const trackOther = async (opts: Parameters<typeof filePending>[2]): Promise<string> => {
    const id = await filePending(otherApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    try {
      hrApi = await ApiClient.as('hr');
      adminApi = await ApiClient.as('admin');
      otherApi = await ApiClient.asAccount('employee2@company.com', 'Password123!');
      branchId = await branchIdByCode(adminApi, 'HO');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('hr')) return;
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    await hrApi?.dispose();
    await otherApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'HR_MANAGER is the second role in advance_loan_approver_roles');
    });

    test('an HR_MANAGER is offered the queue and their decision sticks', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // Somebody ELSE's request. HR's own no longer appears in HR's queue —
      // `findPending` excludes the caller now that self-approval is refused —
      // so filing this one as HR would leave nothing to decide.
      const id = await trackOther({ amount: 600, installments: 6, note: 'hr approves' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');
      await expect.poll(() => loans.rowStatus(id), { timeout: 15_000 }).toBe('PENDING');
      expect(
        await loans.canApprove(id),
        'an HR_MANAGER was offered no approval control',
      ).toBe(true);

      await loans.approve(id, { installments: 2, note: reasonFor('approved by HR') });
      await expect.poll(() => statusOf(hrApi, id), { timeout: 15_000 }).toBe('APPROVED');

      const record = await loanOf(hrApi, id);
      expect(record.installments).toBe(2);
      expect(Number(record.installmentAmount)).toBe(600 / 2);

      settle(problems, 'an HR_MANAGER approval');
    });

    test('an approver is stopped from deciding their own request', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);

      const id = await track({ amount: 300, installments: 3, note: 'self approval' });

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('pending');

      // Both surfaces now agree. `findPending` excludes the caller's own
      // requests, so the queue never offers a control it would have to refuse —
      // which is what the row-detail modal was already doing on its own.
      await page.waitForTimeout(1_000);
      expect(
        await loans.hasRow(id),
        'an approver’s own request was still listed in their own queue',
      ).toBe(false);

      // And the rule stands behind the button rather than depending on it:
      // `assertNotSelfDecision` runs inside `decide` BEFORE the engine, so it
      // binds the chain and the legacy single-approver path alike.
      await expect(
        hrApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('approving my own request'),
          installments: 3,
        }),
        'an approver decided their own request',
      ).rejects.toThrow(
        /403[\s\S]*You cannot decide your own advance\/loan request\. Another approver must review it\./,
      );

      // Rejection is the same door, and it is closed too.
      await expect(
        hrApi.post(`/advance-loans/${id}/reject`, { remarks: reasonFor('rejecting my own') }),
      ).rejects.toThrow(/403/);

      expect(await statusOf(adminApi, id)).toBe('PENDING');
      const record = await loanOf(adminApi, id);
      expect(record.installmentAmount, 'a refused self-approval still wrote terms').toBeFalsy();

      settle(problems, 'an approver refused their own request');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The approver-role setting, from the side that must be refused
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `advance_loan_approver_roles` narrowed to ADMIN alone.
 *
 * The pinned baseline is `ADMIN,HR_MANAGER`, and the route's decorator admits
 * HR_MANAGER too — so with the setting narrowed, an HR_MANAGER is a legitimate
 * caller of the controller who must still be refused. That gap between the
 * decorator and the setting is the whole subject: a test that only checked the
 * decorator would report this surface as covered and be wrong.
 *
 * Both halves are asserted on the same request, because either alone proves the
 * wrong thing — a hidden tab is a UI decision, and a 403 says nothing about
 * what the screen offered.
 */
test.describe('with ADMIN as the only approver role, HR loses the queue', () => {
  let hrApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('hr') || !flagFlipAllowed()) return;
    try {
      hrApi = await ApiClient.as('hr');
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
      // Filed by somebody ELSE. The subject here is the approver-ROLE gate, and
      // an HR-filed request would be refused by the self-approval rule first —
      // a 403 for the wrong reason, which would pass a loose `/403/` assertion
      // while proving nothing about the setting under test.
      const requesterApi = await ApiClient.asAccount('employee2@company.com', 'Password123!');
      try {
        loanId = await filePending(requesterApi, adminApi, {
          amount: 400,
          installments: 4,
          note: 'approver role gate',
        });
      } finally {
        await requesterApi.dispose();
      }
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('hr') && loanId) await retire(loanId, adminApi, adminApi);
    await hrApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so both gates can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be
  // thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the refused half of the approver-role gate');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
    });

    test('the tab disappears and the API refuses the same HR_MANAGER', async ({
      page,
      problems,
    }) => {
      expect(loanId, `setup failed: ${setupError}`).toBeTruthy();

      await withSetting(adminApi, 'advance_loan_approver_roles', 'ADMIN', async () => {
        // The screen reads the list from `/system-settings/public` on load, so
        // the navigation has to happen INSIDE the flip rather than before it.
        await selectBranch(page, branchId);
        const loans = new AdvanceLoansPage(page);
        await loans.open();

        expect(
          await page.getByTestId('loan-tab-pending').count(),
          'HR kept the approval queue after being removed from the approver roles',
        ).toBe(0);

        // The rule, not the screen. Without this the gate would be one `curl`
        // away from irrelevant — and the refusal has to come from the SETTING,
        // since the decorator on this route still admits HR_MANAGER.
        await expect(
          hrApi.post(`/advance-loans/${loanId}/approve`, {
            remarks: reasonFor('approving without the role'),
            installments: 4,
          }),
        ).rejects.toThrow(/not configured to approve/i);

        expect(await statusOf(adminApi, loanId)).toBe('PENDING');
      });

      // The 403 above is the expected outcome and the browser logs every non-2xx
      // it sees; an uncaught render or a 5xx never is, and those stay fatal.
      crashesOnly(problems);
      settle(problems, 'the HR view with the approver role withdrawn');
    });

    test('the queue comes back when the role is restored', async ({ page, problems }) => {
      test.skip(!loanId, 'no request to queue');

      // `withSetting` restores in a `finally`, but "it put the value back" and
      // "the screen recovered" are different claims — and a settings-driven tab
      // that never came back would leave the suite green and the app broken.
      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      await loans.open();

      await expect(page.getByTestId('loan-tab-pending')).toBeVisible({ timeout: 15_000 });
      await loans.openTab('pending');
      await expect.poll(() => loans.hasRow(loanId), { timeout: 15_000 }).toBe(true);

      settle(problems, 'the restored approver queue');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MANAGER: an approver with a second gate on top
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A MANAGER approver, and the department scope that comes with them.
 *
 * MANAGER is the interesting role because it is the only one with TWO gates:
 * membership of `advance_loan_approver_roles`, and `isDeptInManagerScope`. The
 * second is what stops an operations manager approving a finance clerk's loan
 * once somebody adds MANAGER to the list, and it is invisible until the list
 * actually contains MANAGER — which is why this whole describe is behind the
 * flag.
 *
 * `manager@company.com` heads HRD (from `seedManager`) and
 * `manager2@company.com` heads E2E-OPS (from `seedPeopleBaseline`), which is
 * the pair that makes both sides drivable with seeded accounts. manager2 is
 * also this file's subject for the two destructive cases: it is the only
 * loggable account no other spec in the suite touches.
 */
test.describe('a MANAGER approves inside their department and nowhere else', () => {
  let hrdManagerApi: ApiClient;
  let opsManagerApi: ApiClient;
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let opsEmployeeId = '';
  let setupError = '';
  let scratch: Array<{ id: string; owner: ApiClient }> = [];

  const APPROVER_ROLES_WITH_MANAGER = 'ADMIN,HR_MANAGER,MANAGER';

  const track = async (
    owner: ApiClient,
    opts: Parameters<typeof filePending>[2],
  ): Promise<string> => {
    const id = await filePending(owner, adminApi, opts);
    scratch.push({ id, owner });
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('manager') || !flagFlipAllowed()) return;
    try {
      hrdManagerApi = await ApiClient.asAccount(HRD_MANAGER_EMAIL, SEEDED_PASSWORD);
      opsManagerApi = await ApiClient.asAccount(OPS_MANAGER_EMAIL, SEEDED_PASSWORD);
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
      opsEmployeeId = await employeeIdByCode(adminApi, 'MGR002');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('manager') || !flagFlipAllowed()) return;
    for (const { id, owner } of scratch) await retire(id, owner, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('manager') && flagFlipAllowed() && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      // Belt and braces for the termination case below. An account left
      // INACTIVE would take every later run of this describe with it — and,
      // because the soft delete kills the LOGIN too, every later SPEC that
      // logs in as manager2 (`finance-loan-data-integrity.spec.ts` among
      // them). `restoreSeededAccount` puts both rows back; the employee row
      // alone is not enough.
      await restoreSeededAccount(adminApi, opsEmployeeId, OPS_MANAGER_EMAIL);
    }
    await hrdManagerApi?.dispose();
    await opsManagerApi?.dispose();
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so both gates can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be
  // thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the MANAGER half of the approver gate');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
    });

    test('the queue a MANAGER is shown is their department and not the company', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const mine = await track(employeeApi, {
        amount: 600,
        installments: 6,
        note: 'in the HRD manager\'s scope',
      });
      const theirs = await track(opsManagerApi, {
        amount: 600,
        installments: 6,
        note: 'outside the HRD manager\'s scope',
      });

      await withSetting(
        adminApi,
        'advance_loan_approver_roles',
        APPROVER_ROLES_WITH_MANAGER,
        async () => {
          await selectBranch(page, branchId);
          const loans = new AdvanceLoansPage(page);
          await loans.open();

          // The tab exists at all only because the setting now names MANAGER —
          // `finance-loan-lifecycle.spec.ts` asserts its absence under the
          // pinned value, which is the same fact from the other side.
          await expect(page.getByTestId('loan-tab-pending')).toBeVisible({ timeout: 15_000 });
          await loans.openTab('pending');

          // `findPending` narrows to `managerDeptScope(user)` for a MANAGER, so
          // the scope is enforced by the QUERY and not only by the decision.
          // Without this half the refusal below would still pass while every
          // manager in the company read every request.
          await expect.poll(() => loans.hasRow(mine), { timeout: 15_000 }).toBe(true);
          expect(
            await loans.hasRow(theirs),
            'a request from another department was in this manager\'s queue',
          ).toBe(false);
        },
      );

      settle(problems, 'the MANAGER approval queue');
    });

    test('a MANAGER decides inside their department and is refused outside it', async () => {
      test.skip(!isProject('manager'), 'the rule, not the screen');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const mine = await track(employeeApi, {
        amount: 600,
        installments: 6,
        note: 'HRD request for the HRD manager',
      });
      const theirs = await track(opsManagerApi, {
        amount: 600,
        installments: 6,
        note: 'E2E-OPS request for the HRD manager',
      });

      await withSetting(
        adminApi,
        'advance_loan_approver_roles',
        APPROVER_ROLES_WITH_MANAGER,
        async () => {
          // The second gate, in the server's own words. A MANAGER who passed
          // the role list and failed the scope is exactly the case the
          // decorator cannot express.
          await expect(
            hrdManagerApi.post(`/advance-loans/${theirs}/approve`, {
              remarks: reasonFor('approving another department'),
              installments: 6,
            }),
          ).rejects.toThrow(/only review requests from your own department/i);
          expect(await statusOf(adminApi, theirs)).toBe('PENDING');

          // And the positive half, on the same call in the same configuration —
          // without it, a gate that refused everything would look identical.
          await hrdManagerApi.post(`/advance-loans/${mine}/approve`, {
            remarks: reasonFor('approving my own department'),
            installments: 6,
          });
          await expect.poll(() => statusOf(adminApi, mine), { timeout: 15_000 }).toBe('APPROVED');
        },
      );
    });

    test('the advance affordability cap is checked at approval, not at submission', async () => {
      test.skip(!isProject('manager'), 'the rule, not the screen');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The gate is `amount > monthlyNetProxy * pct/100`, and the proxy is the
      // sum of active earning components or, failing that, the base salary.
      // Every seeded account carries `baseSalary: 0`, so the cap CANNOT fire
      // for any of them as they ship — which is a finding in its own right and
      // is asserted first, before the salary is set up to make it fire.
      const zeroPay = await track(opsManagerApi, {
        type: 'ADVANCE',
        amount: 300,
        note: 'advance cap against no recorded pay',
      });
      await withSetting(adminApi, 'advance_max_percent_of_salary', '1', async () => {
        // BUG?: the affordability cap is guarded by `proxy > 0`, so an employee whose pay
        // is not recorded — every account in the baseline seed — can be approved for any
        // advance at all, whatever the percentage is set to.
        await adminApi.post(`/advance-loans/${zeroPay}/approve`, {
          remarks: reasonFor('approved despite the 1% cap'),
        });
        await expect.poll(() => statusOf(adminApi, zeroPay), { timeout: 15_000 }).toBe('APPROVED');
      });

      // Now with a salary on the record, so the same setting has something to
      // measure against. Restored in a `finally`: a base salary left behind
      // would change what every later payroll run pays this person.
      await adminApi.patch(`/employees/${opsEmployeeId}`, { baseSalary: 2000 });
      try {
        const paid = await track(opsManagerApi, {
          type: 'ADVANCE',
          amount: 500,
          note: 'advance cap against recorded pay',
        });

        await withSetting(adminApi, 'advance_max_percent_of_salary', '10', async () => {
          // 10% of 2000 is 200, and the request is for 500. The refusal names
          // both figures and says what to do instead, which is the difference
          // between an approver correcting the request and an approver guessing.
          await expect(
            adminApi.post(`/advance-loans/${paid}/approve`, {
              remarks: reasonFor('approving above the cap'),
            }),
          ).rejects.toThrow(/exceeds 10% of the employee's monthly pay/i);
          expect(await statusOf(adminApi, paid)).toBe('PENDING');
        });

        // The same request, same amount, with only the setting moved — which is
        // what proves the refusal came from the cap and not from the amount.
        await adminApi.post(`/advance-loans/${paid}/approve`, {
          remarks: reasonFor('approved under the default cap'),
        });
        await expect.poll(() => statusOf(adminApi, paid), { timeout: 15_000 }).toBe('APPROVED');
      } finally {
        await adminApi.patch(`/employees/${opsEmployeeId}`, { baseSalary: 0 }).catch(() => undefined);
      }
    });

    /**
     * ⚠ DESTRUCTIVE TO THE WHOLE SUITE, and deliberately LAST in this describe.
     *
     * READ THIS BEFORE TERMINATING ANY SEEDED ACCOUNT ANYWHERE.
     * `DELETE /employees/:id` does not only end an employment: in the same
     * transaction it sets `User.isActive = false` on the linked login, and
     * `PATCH /employees/:id { status: 'ACTIVE' }` does NOT undo that half —
     * `EmployeesService.update()` never touches the User row. Terminating a
     * login-capable seeded account and restoring only the employee therefore
     * leaves the account permanently unable to authenticate for the REST OF THE
     * RUN, and the failure surfaces in whichever later file logs in as it (a
     * bare `401` at `beforeAll`) rather than here. That is exactly how
     * `finance-loan-data-integrity.spec.ts`, thirteen files later, came to fail
     * on an account it only reads.
     *
     * So: prefer a disposable `makeEmployee()` subject whenever the case allows
     * it, and when it does not — as here, because there is no way to FILE a
     * request as an API-created employee (`POST /employees` mints a random
     * temporary password nobody can read; see `loan-support.ts`'s `NO_LOGIN`) —
     * restore BOTH rows through `restoreSeededAccount`, in a `finally` and
     * again in `afterAll`, and assert the login actually came back.
     *
     * manager2 is used because it is the account with the fewest other readers.
     * "Nobody else touches it" was never a licence to leave it broken.
     */
    test('a request filed before the employee left is refused after they leave', async () => {
      test.skip(!isProject('manager'), 'the rule, not the screen');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      expect(opsEmployeeId, 'no employee to terminate').toBeTruthy();

      const id = await filePending(opsManagerApi, adminApi, {
        amount: 600,
        installments: 6,
        note: 'filed before leaving',
      });

      try {
        // Eligibility is evaluated at CREATE, so a request filed while somebody
        // was employed sits there perfectly valid. `applyApproved` now re-runs
        // the two rules that can go stale in the meantime — `EMPLOYEE_ACTIVE`
        // and `NOT_AFTER_RESIGNATION` — rather than only re-checking the
        // instalment range and the advance cap.
        await terminateEmployee(adminApi, opsEmployeeId);
        const employee = await adminApi.get<{ status: string }>(`/employees/${opsEmployeeId}`);
        expect(employee.status, 'the soft delete did not mark the employee as having left').toBe(
          'INACTIVE',
        );

        // Approving would commit a recovery schedule against payroll cycles
        // that will never run for this person. It is refused, and it says why.
        await expect(
          adminApi.post(`/advance-loans/${id}/approve`, {
            remarks: reasonFor('approved after the employee left'),
            installments: 6,
          }),
          'a loan was approved for somebody who had already left',
        ).rejects.toThrow(
          /400[\s\S]*the employee is no longer active \(status INACTIVE\)\. Eligibility is re-checked at approval time\./,
        );

        // Refused all the way down: no terms, no schedule, still PENDING.
        expect(await statusOf(adminApi, id)).toBe('PENDING');
        expect((await scheduleOf(adminApi, id)).length).toBe(0);
        expect((await loanOf(adminApi, id)).installmentAmount).toBeFalsy();

        // The subset is deliberate: re-running the WHOLE eligibility set would
        // refuse every approval, because MAX_ACTIVE_LOANS counts the very
        // request being approved and DUPLICATE_REFERENCE matches itself. Put
        // the person back and the same request approves cleanly.
        await restoreSeededAccount(adminApi, opsEmployeeId, OPS_MANAGER_EMAIL);
        await adminApi.post(`/advance-loans/${id}/approve`, {
          remarks: reasonFor('approved once they were back'),
          installments: 6,
        });
        await expect.poll(() => statusOf(adminApi, id), { timeout: 15_000 }).toBe('APPROVED');
        expect((await scheduleOf(adminApi, id)).length).toBe(6);
      } finally {
        await retire(id, adminApi, adminApi);
        // Both halves, every time. See `restoreSeededAccount` for why putting
        // the EMPLOYEE back is only half of undoing a soft delete.
        await restoreSeededAccount(adminApi, opsEmployeeId, OPS_MANAGER_EMAIL);
      }

      // The restore is ASSERTED, not assumed — and this is the assertion that
      // would have caught the contamination at its source instead of thirteen
      // files later. A login this spec broke and did not repair is a failure OF
      // THIS SPEC, however green the approval half looked.
      const proof = await ApiClient.asAccount(OPS_MANAGER_EMAIL, SEEDED_PASSWORD).catch(
        (e: Error) => {
          throw new Error(
            `${OPS_MANAGER_EMAIL} cannot log in after this test terminated and restored it ` +
              `(${e.message}). Every later spec that logs in as this account will now fail ` +
              `at setup with a 401. See restoreSeededAccount().`,
          );
        },
      );
      await proof.dispose();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Losing an approver mid-flight
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What happens to a pending request when one of its possible approvers leaves.
 *
 * The honest form of this case, given what the API allows. An employee created
 * over the API cannot log in (`loan-support.ts` explains why at length), so the
 * approver cannot be made to hold the request before being terminated — and
 * terminating one of the four seeded accounts would take the rest of the suite
 * with it. What IS assertable, and is the claim that actually matters, is that
 * approval here is bound to a ROLE and never to a person: no `approverId` is
 * reserved when a request is filed, so losing an approver cannot strand it.
 *
 * Contrast with the chained case below, where a step CAN resolve to a named
 * approver — that is the configuration in which this question has teeth.
 */
test.describe('losing an approver does not strand a pending request', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let loanId = '';
  let setupError = '';
  let approverEmployeeId = '';
  let approverUserId: string | undefined;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && loanId) await retire(loanId, employeeApi, adminApi);
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'terminating people is an administrative act');
    });

    test('an approver who leaves is deactivated, and the request is still decidable', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      loanId = await filePending(employeeApi, adminApi, {
        amount: 600,
        installments: 6,
        note: 'approver leaves mid-flight',
      });

      // A real second approver, made and disposed of by this test alone. The
      // role is set through `PATCH /users/:id/role`, because the login
      // `POST /employees` creates is always EMPLOYEE.
      // The retry counter is in the marker because `makeEmployee` derives the
      // login's email from it: a retried attempt would otherwise ask for an
      // address the first attempt already took and fail on a uniqueness clash
      // instead of on whatever it was actually testing.
      const approver = await makeEmployee(adminApi, {
        marker: `${MARK}appr${test.info().retry}`,
        role: 'HR_MANAGER',
      });
      approverEmployeeId = approver.id;
      approverUserId = approver.userId;
      expect(approverEmployeeId, 'no approver was created to terminate').toBeTruthy();

      await terminateEmployee(adminApi, approverEmployeeId);

      const employee = await adminApi.get<{ status: string }>(`/employees/${approverEmployeeId}`);
      expect(employee.status).toBe('INACTIVE');
      if (approverUserId) {
        const user = await adminApi.get<{ isActive: boolean }>(`/users/${approverUserId}`);
        expect(user.isActive, 'the departed approver kept a live login').toBe(false);
      }

      // The request never named them, so it never lost anything. This is the
      // property that makes the legacy single-approver path robust — and the
      // one the configurable chain gives up, because a chain step CAN resolve
      // to a specific user id.
      const before = await loanOf(adminApi, loanId);
      expect(before.status).toBe('PENDING');
      expect(before.approverId, 'a pending request had already reserved an approver').toBeFalsy();

      await adminApi.post(`/advance-loans/${loanId}/approve`, {
        remarks: reasonFor('decided by the remaining approver'),
        installments: 6,
      });
      await expect.poll(() => statusOf(adminApi, loanId), { timeout: 15_000 }).toBe('APPROVED');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The configurable approval chain
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A loan under a multi-step `ApprovalWorkflow`.
 *
 * Two switches have to be on together before the engine is engaged at all —
 * `supervisor_approval_enabled` (pinned `'false'` in the e2e baseline) AND an
 * active workflow for `ADVANCE_LOAN` — and the trail rows are written at CREATE
 * time by `initiate`, so a request filed before either is on carries no chain
 * and can never gain one. That ordering is the single easiest thing to get
 * wrong here, and it is why the request is filed inside the flip rather than in
 * `beforeAll`.
 *
 * The workflow IS creatable over the API: `PUT /approval-workflows` (ADMIN)
 * upserts the active chain for a request type and `PATCH /:id/active` toggles
 * it, so this describe needs no database access and no skip of its own beyond
 * the flag.
 *
 * `decide()` deviates from `travel.service.ts` on purpose: `!engaged` means
 * "fall back to the legacy single approver", NOT "approve now" — copying travel
 * here would auto-approve every loan the moment the kill-switch was off, which
 * is the default. So the intermediate step is the only case where a decision
 * returns without changing the status, and it is what this describe asserts.
 */
test.describe('a chained approval records the step and waits for the next one', () => {
  let employeeApi: ApiClient;
  let hrApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    try {
      employeeApi = await ApiClient.as('employee');
      hrApi = await ApiClient.as('hr');
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && flagFlipAllowed() && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await employeeApi?.dispose();
    await hrApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so both gates can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be
  // thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the chain is installed and torn down by an ADMIN');
      test.skip(!flagFlipAllowed(), FLAG_SKIP);
    });

    test('an intermediate decision leaves the request pending until the last step', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // Snapshot what was active for this type. The upsert DEACTIVATES it, and
      // a workflow left switched off is a change to shared configuration just
      // as surely as a flipped flag is.
      const before = await adminApi.get<Array<{ id: string; requestType: string; isActive: boolean }>>(
        '/approval-workflows',
      );
      const previouslyActive = (Array.isArray(before) ? before : []).filter(
        (w) => w.isActive && w.requestType === 'ADVANCE_LOAN',
      );

      let workflowId = '';
      let loanId = '';

      try {
        await withSettings(adminApi, { supervisor_approval_enabled: 'true' }, async () => {
          const workflow = await adminApi.put<{ id: string }>('/approval-workflows', {
            requestType: 'ADVANCE_LOAN',
            name: `pw loan approval ${MARK}`,
            mode: 'SEQUENTIAL',
            steps: [{ approverType: 'HR_MANAGER' }, { approverType: 'ADMIN' }],
          });
          workflowId = workflow?.id ?? '';
          expect(workflowId, 'the chain was not created').toBeTruthy();

          // Filed INSIDE the flip: `initiate` writes the trail on create, and a
          // request filed a moment earlier would be governed by nothing.
          loanId = await filePending(employeeApi, adminApi, {
            amount: 600,
            installments: 6,
            note: 'two-step chain',
          });

          const trail = await employeeApi.get<{ engaged: boolean; steps: unknown[] }>(
            `/approval-workflows/trail/ADVANCE_LOAN/${loanId}`,
          );
          expect(trail?.engaged, 'the request was filed without a chain governing it').toBe(true);
          expect(trail?.steps?.length).toBe(2);

          // Step 1. The response is the whole claim: a decision was RECORDED
          // and the request was not decided. An engine that finalized here
          // would approve a loan on one signature where two were configured.
          const first = await hrApi.post<unknown>(`/advance-loans/${loanId}/approve`, {
            remarks: reasonFor('step one'),
            installments: 6,
          });
          // The STATUS the intermediate step answers with, not its sentence.
          // `advance-loans.service.ts` returns `{ success, message, data }` and
          // `ApiClient` unwraps one `{ success, data }`, so the message never
          // reaches a spec at all — and the wording is not a contract anyway
          // (`leave-requests.service.ts` words the same event "Approval
          // recorded…"). PENDING in the answer, and PENDING when the request is
          // read back, is the claim: an engine that finalized here would approve
          // a loan on one signature where two were configured.
          expect((first as { status?: string })?.status).toBe('PENDING');
          expect(await statusOf(adminApi, loanId)).toBe('PENDING');

          // No terms yet either — the schedule is written by `applyApproved`,
          // which the intermediate step never reaches.
          const midway = await loanOf(adminApi, loanId);
          expect(midway.installmentAmount, 'an undecided request was given terms').toBeFalsy();
          expect((await scheduleOf(adminApi, loanId)).length).toBe(0);

          // Step 2 finalizes, and only now does the legacy apply-path run.
          await adminApi.post(`/advance-loans/${loanId}/approve`, {
            remarks: reasonFor('step two'),
            installments: 6,
          });
          await expect
            .poll(() => statusOf(adminApi, loanId), { timeout: 15_000 })
            .toBe('APPROVED');

          const final = await loanOf(adminApi, loanId);
          expect(Number(final.installmentAmount)).toBe(600 / 6);
          expect((await scheduleOf(adminApi, loanId)).length).toBe(6);
        });
      } finally {
        if (loanId) await retire(loanId, employeeApi, adminApi).catch(() => undefined);
        if (workflowId) {
          await adminApi
            .patch(`/approval-workflows/${workflowId}/active`, { isActive: false })
            .catch(() => undefined);
        }
        for (const wf of previouslyActive) {
          await adminApi
            .patch(`/approval-workflows/${wf.id}/active`, { isActive: true })
            .catch(() => undefined);
        }
      }
    });
  });
});
