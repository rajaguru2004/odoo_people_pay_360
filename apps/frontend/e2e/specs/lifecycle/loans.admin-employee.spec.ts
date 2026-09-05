import { test, expect, settle, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, LoanDetailPage, selectBranch } from '../../pages';

/**
 * A salary loan, from request to a repayment schedule.
 *
 * The step that carries the money is APPROVAL, not submission: approving is what
 * fixes the repayment period, computes the instalment and writes the
 * amortization schedule payroll will later recover against. An approver who
 * types "4" into the review modal and gets a six-instalment schedule has
 * silently changed what the employee owes each month, and no per-screen test
 * sees that — the button reacts, the toast appears, and the plan is wrong.
 *
 * So the assertion here is deliberately not "the screen says approved". It is
 * that the record's `installments`, its `installmentAmount` and the number of
 * rows in the schedule all agree with the number the approver typed.
 *
 * Two facts this file encodes, both of which are easy to get wrong:
 *
 *   • Who may approve comes from the `advance_loan_approver_roles` SETTING
 *     (`ADMIN,HR_MANAGER`), not from RBAC. An EMPLOYEE is not in it, which is
 *     what makes self-approval impossible — there is no separate "not your own
 *     request" rule to lean on.
 *   • The row-level Approve control only exists where `activeTab !== 'my'`, so
 *     the approver has to be on their queue, not on their own history.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const marker = `pw-loan-${Date.now().toString(36)}`;

/**
 * Statuses that still count against the employee's live-loan allowance.
 *
 * `MAX_ACTIVE_LOANS` is 2 by default, so a file that leaves its loans open stops
 * working on the third run against a database nobody reset. Every loan created
 * here is therefore retired at the end, and stragglers from a crashed earlier
 * run are swept only when the server says the allowance is actually exhausted.
 */
const OPEN_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'ACTIVE', 'ON_HOLD', 'OVERDUE'];

interface LoanRecord {
  id: string;
  status: string;
  type: string;
  amount: string;
  installments: number;
  installmentAmount: string | null;
  employeeId: string;
}

/**
 * Retires ONE loan this file created.
 *
 * Two different exits, because the engine has two: a PENDING request is
 * cancelled by its owner, while a disbursed one carries a balance and `close`
 * refuses it outright ("Outstanding balance is 600, above the rounding
 * tolerance") — writing it off is the operation that actually releases the
 * allowance.
 *
 * Deliberately targeted rather than a sweep of everything the employee owns:
 * the two halves of this journey run in different Playwright projects, which
 * are different workers, so a blanket tidy-up in one could cancel the request
 * the other is halfway through approving.
 */
async function retire(loanId: string, employee: ApiClient, admin: ApiClient): Promise<void> {
  const loan = await employee.get<LoanRecord>(`/advance-loans/${loanId}`).catch(() => null);
  if (!loan || !OPEN_STATUSES.includes(loan.status)) return;

  if (loan.status === 'PENDING' || loan.status === 'DRAFT') {
    await employee.delete(`/advance-loans/${loanId}`).catch(() => undefined);
    return;
  }
  await admin
    .post(`/advance-loans/${loanId}/write-off`, { reason: `${marker} — journey finished` })
    .catch(() => undefined);
}

/**
 * Makes room for one more loan, but only if there is none.
 *
 * `MAX_ACTIVE_LOANS` is 2, so leftovers from a crashed earlier run would stop
 * this file working against a database nobody reset. The sweep is gated on the
 * server's own eligibility answer rather than run unconditionally, because on
 * the reset database this suite documents there is nothing to sweep — and not
 * sweeping is what keeps the two projects from treading on each other.
 */
async function ensureAllowance(employee: ApiClient, admin: ApiClient, amount: number): Promise<void> {
  const check = async () =>
    employee
      .post<{ eligible: boolean }>('/advance-loans/eligibility', { amount, installments: 6, type: 'LOAN' })
      .catch(() => ({ eligible: true }));

  if ((await check()).eligible) return;

  const mine = await employee
    .get<LoanRecord[] | { data?: LoanRecord[] }>('/advance-loans/my-requests')
    .catch(() => [] as LoanRecord[]);
  const list = Array.isArray(mine) ? mine : (mine?.data ?? []);
  for (const loan of list.filter((l) => OPEN_STATUSES.includes(l.status))) {
    await retire(loan.id, employee, admin);
  }
}

test.describe('an employee requests a loan', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the requester half of the journey');
  });

  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    employeeApi = await ApiClient.as('employee');
    adminApi = await ApiClient.as('admin');
    branchId = await adminApi.firstBranchId();
    await ensureAllowance(employeeApi, adminApi, 600);
  });

  test.afterAll(async () => {
    if (isProject('employee') && loanId) await retire(loanId, employeeApi, adminApi);
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  test('the request form files a LOAN and it lands PENDING', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('my');

    await loans.submitRequest({
      type: 'LOAN',
      amount: 600,
      installments: 6,
      reason: `Automated journey ${marker} — school fees`,
    });

    // Read the id back from the server rather than from the screen: the point of
    // the next assertions is that the record exists, not that the list rendered.
    const mine = await employeeApi.get<LoanRecord[]>('/advance-loans/my-requests');
    const created = mine.find((l) => l.status === 'PENDING' && Number(l.amount) === 600);
    expect(created, 'the submitted request is not in the employee\'s own list').toBeTruthy();
    loanId = created!.id;

    expect(created!.type).toBe('LOAN');
    // The requester states a preference; nothing is settled until an approver
    // acts, so there is no instalment amount yet.
    expect(created!.installmentAmount).toBeFalsy();

    await loans.open();
    await loans.openTab('my');
    await expect.poll(() => loans.rowStatus(loanId), { timeout: 15_000 }).toBe('PENDING');

    settle(problems, 'filing a loan request');
  });

  test('the requester is offered no way to approve their own request', async ({ page, problems }) => {
    test.skip(!loanId, 'nothing was filed');

    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('my');

    expect(await loans.hasRow(loanId), 'the request vanished from the employee\'s list').toBe(true);
    expect(
      await loans.canApprove(loanId),
      'an employee was offered the approval control on their own request',
    ).toBe(false);

    // The approver queue is not theirs to see either — an EMPLOYEE is not in
    // `advance_loan_approver_roles`, so the tab does not exist for them.
    expect(await page.getByTestId('loan-tab-pending').count()).toBe(0);

    settle(problems, 'the requester view of a pending loan');
  });

  test('the API refuses a self-approval even when asked directly', async () => {
    test.skip(!loanId, 'nothing was filed');

    // A hidden button is a UI decision; this is the rule. Without it the guard
    // would be one `curl` away from irrelevant.
    await expect(
      employeeApi.post(`/advance-loans/${loanId}/approve`, { remarks: 'me', installments: 6 }),
    ).rejects.toThrow();

    const after = await employeeApi.get<LoanRecord>(`/advance-loans/${loanId}`);
    expect(after.status).toBe('PENDING');
  });
});

/**
 * The approver's half.
 *
 * Seeds its own request over the API rather than depending on the employee
 * project having run first — Playwright projects share no state, so a
 * cross-project dependency would make this file order-sensitive.
 */
test.describe('an approver sets the repayment period', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the approver half of the journey');
  });

  test.describe.configure({ mode: 'serial' });

  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let setupError = '';

  /** What the requester asked for, and what the approver will overrule it with. */
  const REQUESTED_INSTALMENTS = 6;
  const APPROVED_INSTALMENTS = 4;
  const AMOUNT = 600;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    employeeApi = await ApiClient.as('employee');
    adminApi = await ApiClient.as('admin');

    try {
      branchId = await adminApi.firstBranchId();
      await ensureAllowance(employeeApi, adminApi, AMOUNT);

      const created = await employeeApi.post<LoanRecord>('/advance-loans', {
        type: 'LOAN',
        amount: AMOUNT,
        installments: REQUESTED_INSTALMENTS,
        reason: `Automated journey ${marker} — approver half`,
      });
      loanId = created.id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && loanId) await retire(loanId, employeeApi, adminApi);
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  test('the request is waiting in the approver queue', async ({ page, problems }) => {
    expect(loanId, `no request to approve: ${setupError}`).toBeTruthy();

    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('pending');

    await expect.poll(() => loans.rowStatus(loanId), { timeout: 15_000 }).toBe('PENDING');
    expect(await loans.canApprove(loanId), 'the approver was offered no approval control').toBe(true);

    settle(problems, 'the approver queue');
  });

  test('approving with an overridden instalment count rewrites the terms', async ({ page, problems }) => {
    test.skip(!loanId, 'no request to approve');

    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('pending');

    await loans.approve(loanId, {
      installments: APPROVED_INSTALMENTS,
      note: `Approved by the automated journey ${marker}`,
    });

    // The claim under test: the number typed into the modal is the number the
    // record now carries, not the one the employee asked for.
    await expect
      .poll(async () => (await adminApi.get<LoanRecord>(`/advance-loans/${loanId}`)).status, {
        timeout: 20_000,
      })
      .toBe('APPROVED');

    const record = await adminApi.get<LoanRecord>(`/advance-loans/${loanId}`);
    expect(record.installments, 'the approver\'s override did not reach the record').toBe(
      APPROVED_INSTALMENTS,
    );
    expect(Number(record.installmentAmount)).toBe(AMOUNT / APPROVED_INSTALMENTS);

    settle(problems, 'approving a loan');
  });

  test('a repayment schedule exists, one row per approved instalment', async ({ page, problems }) => {
    test.skip(!loanId, 'no request to approve');

    const record = await adminApi.get<LoanRecord>(`/advance-loans/${loanId}`);
    test.skip(record.status !== 'APPROVED', 'the request never reached APPROVED');

    await selectBranch(page, branchId);
    const detail = new LoanDetailPage(page);
    await detail.open(loanId);

    expect(await detail.status()).toBe('APPROVED');
    expect(await detail.installments()).toBe(String(APPROVED_INSTALMENTS));

    // A loan whose status says APPROVED but whose schedule is empty has nothing
    // for payroll to recover against — it would quietly never be repaid.
    await expect
      .poll(() => detail.scheduleRowCount(), { timeout: 15_000 })
      .toBe(APPROVED_INSTALMENTS);

    settle(problems, 'the approved loan detail screen');
  });

  test('a decided request can no longer be decided', async ({ page, problems }) => {
    test.skip(!loanId, 'no request to approve');

    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('pending');

    // It has left the queue, and the API refuses a second decision — without
    // that, two approvers racing would each write their own schedule.
    expect(await loans.hasRow(loanId), 'a decided request is still in the pending queue').toBe(false);
    await expect(
      adminApi.post(`/advance-loans/${loanId}/approve`, { remarks: 'again', installments: 2 }),
    ).rejects.toThrow();

    settle(problems, 'the queue after a decision');
  });
});
