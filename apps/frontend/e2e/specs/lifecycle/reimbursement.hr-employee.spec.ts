import { test, expect, settle, ApiClient } from '../../fixtures';
import { ReimbursementsPage, selectBranch } from '../../pages';

/**
 * Reimbursements, filed and decided.
 *
 * In the suite because approval here is a money commitment, not a status
 * change: an approved claim is picked up by the next payroll run and paid. A
 * screen that reports success without persisting therefore leaves an employee
 * unpaid, with no error visible to anyone.
 *
 * The expense type list is not hardcoded here — it comes from the
 * `reimbursement_types` setting, so the page object picks whatever the first
 * configured option is. A test that named "Travel" would start failing the day
 * a client renamed their categories, which is a test problem, not a bug.
 *
 * Note the asymmetry the specs encode: an ADMIN administers reimbursements but
 * cannot submit one (`@Roles('HR_MANAGER','MANAGER','EMPLOYEE')` on create), and
 * approval is gated by the `reimbursement_approver_roles` setting rather than by
 * RBAC. Both are easy to break from either side.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const marker = `pw-reimb-${Date.now().toString(36)}`;

/** Expense dates are in the past — the form's `max` is today. */
function pastDate(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

interface Reimbursement {
  id: string;
  status: string;
  amount?: string | number;
  approverRemarks?: string | null;
  rejectedReason?: string | null;
}

test.describe('an employee claims an expense', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the employee claims');
  });

  let api: ApiClient;
  let filedId: string | undefined;

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    api = await ApiClient.as('employee');
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('the claim form is offered and opens', async ({ page, problems }) => {
    const screen = new ReimbursementsPage(page);
    await screen.open();

    expect(await screen.canRequest(), 'the employee was not offered the claim button').toBe(true);
    await screen.openForm();

    settle(problems, 'the reimbursement form');
  });

  test('a claim is filed and appears as PENDING', async ({ page, problems }) => {
    const screen = new ReimbursementsPage(page);
    await screen.open();
    await screen.openForm();
    await screen.fill({
      amount: '1250.50',
      date: pastDate(5),
      description: `Automated journey ${marker} — client visit cab fare`,
    });
    await screen.submit();

    const mine = await api.get<Reimbursement[]>('/reimbursements/my-requests');
    await expect
      .poll(async () => {
        const list = await api.get<Reimbursement[]>('/reimbursements/my-requests');
        return (Array.isArray(list) ? list : []).length;
      }, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(Array.isArray(mine) ? mine.length : 0);

    const list = await api.get<Reimbursement[]>('/reimbursements/my-requests');
    const filed = (Array.isArray(list) ? list : []).find((r) => r.status === 'PENDING');
    expect(filed, 'no pending claim exists on the server after filing one').toBeTruthy();
    filedId = filed!.id;

    // Filed as 1250.50 — a claim that silently becomes 1250 or 125050 is the
    // sort of thing only an assertion on the value catches.
    expect(Number(filed!.amount)).toBeCloseTo(1250.5, 2);

    await screen.open();
    await screen.expectRowStatus(filedId, 'PENDING');

    settle(problems, 'filing a reimbursement claim');
  });

  test('the employee is not offered a decision on their own claim', async ({ page, problems }) => {
    test.skip(!filedId, 'the filing step did not produce an id');

    const screen = new ReimbursementsPage(page);
    await screen.open();

    expect(await screen.canReview(filedId!), 'an employee was offered approve/reject on their own claim').toBe(false);

    settle(problems, 'an employee viewing their own claim');
  });
});

test.describe('HR decides a claim', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'HR decides');
  });

  test.describe.configure({ mode: 'serial' });

  let employeeApi: ApiClient;
  let approveId: string;
  let rejectId: string;
  let branchId = '';

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    employeeApi = await ApiClient.as('employee');
    const adminApi = await ApiClient.as('admin');
    branchId = await adminApi.firstBranchId();
    await adminApi.dispose();

    const mk = async (tag: string, amount: number) => {
      const created = await employeeApi.post<Reimbursement>('/reimbursements', {
        type: 'Travel',
        amount,
        expenseDate: `${pastDate(12)}T00:00:00.000Z`,
        description: `Automated journey ${marker} — ${tag}`,
      });
      return created.id;
    };

    approveId = await mk('approval half', 800);
    rejectId = await mk('rejection half', 900);
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
  });

  test('HR approves with a remark, and the record follows', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new ReimbursementsPage(page);
    await screen.open();
    await screen.openTab('pending');

    expect(await screen.hasRow(approveId), 'HR could not see a pending claim').toBe(true);
    expect(await screen.canReview(approveId), 'HR was not offered the decision controls').toBe(true);

    await screen.review(approveId, 'approve', `Verified against the invoice — ${marker}`);

    // The approved claim leaves the pending tab, so the status has to be read
    // where settled claims live rather than where it was decided.
    await screen.openTab('all');
    await screen.expectRowStatus(approveId, 'APPROVED');

    const record = await employeeApi.get<Reimbursement>(`/reimbursements/${approveId}`);
    expect(record.status).toBe('APPROVED');
    expect(record.approverRemarks, 'the approval remark was not stored').toContain(marker);

    settle(problems, 'approving a reimbursement');
  });

  test('an approved claim is no longer decidable', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new ReimbursementsPage(page);
    await screen.open();
    await screen.openTab('all');
    expect(await screen.canReview(approveId), 'a settled claim still offered a decision').toBe(false);

    settle(problems, 'a settled reimbursement');
  });

  test('rejection carries its reason', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const screen = new ReimbursementsPage(page);
    await screen.open();
    await screen.openTab('pending');
    await screen.review(rejectId, 'reject', `Rejected by the automated journey ${marker}`);

    await screen.openTab('all');
    await screen.expectRowStatus(rejectId, 'REJECTED');

    const record = await employeeApi.get<Reimbursement>(`/reimbursements/${rejectId}`);
    expect(record.status).toBe('REJECTED');
    expect(record.rejectedReason, 'the rejection reason was not stored').toContain(marker);

    settle(problems, 'rejecting a reimbursement');
  });
});
