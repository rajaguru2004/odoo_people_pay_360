import { test, expect, settle, ApiClient } from '../../fixtures';
import { OvertimeDetailPage, OvertimeListPage, OvertimeRequestPage, selectBranch } from '../../pages';

/**
 * Overtime, from filing to decision.
 *
 * Pay-affecting, and unusual in that the screen computes the money. The form
 * previews payable hours split across the regular / late / double tiers, and an
 * approved request feeds that split straight into payroll. A tier boundary that
 * moves, or a day-end clamp that stops clamping, changes what people are paid
 * with no error anywhere.
 *
 * The validation case here is a real defect that was fixed once and can regress:
 * an end time equal to the start time used to roll forward a day and submit a
 * ~19-hour claim plus a food allowance. `utils/overtimeCalc.ts` has unit tests
 * for the arithmetic; this asserts the form actually refuses it.
 *
 * Depends on `overtime_enabled = true`, pinned in the baseline seed.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const marker = `pw-ot-${Date.now().toString(36)}`;

/** The form's `min` is today, so overtime is always filed forward. */
const RUN_NUDGE = Date.now() % 60;

function futureDate(offsetDays: number): string {
  return new Date(Date.now() + (offsetDays + RUN_NUDGE) * 86_400_000).toISOString().slice(0, 10);
}

interface Overtime {
  id: string;
  status: string;
  hours?: number | string;
}

test.describe('an employee files overtime', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the employee files');
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

  test('an end time equal to the start time is refused', async ({ page, problems }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: futureDate(30),
      start: '19:00',
      end: '19:00',
      reason: `Automated journey ${marker} — zero-length claim`,
    });
    await form.submit();

    // The regression: `end <= start` used to roll forward a day, turning a
    // zero-length claim into a ~19-hour one. The form must stay put and say so.
    expect(await form.stillOnForm(), 'a zero-length overtime claim was accepted').toBe(true);
    const errors = await form.fieldErrors();
    expect(errors.join(' '), 'no validation message was shown for an invalid time range').not.toBe('');

    settle(problems, 'a zero-length overtime claim');
  });

  test('a valid claim is filed and lands PENDING', async ({ page, problems }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: futureDate(30),
      start: '19:00',
      end: '22:00',
      reason: `Automated journey ${marker} — release cutover support`,
    });
    await form.submit();

    // The form navigates away on success; that redirect is part of the flow.
    await page.waitForURL(/\/dashboard\/(my-overtime|overtime)/, { timeout: 20_000 });

    // Polled, and NOT swallowed with a `.catch`: a failing read here used to
    // look identical to a claim that was never created.
    const pending = async () => {
      const mine = await api.get<Overtime[]>('/overtime/my-requests');
      return (Array.isArray(mine) ? mine : []).filter((o) => o.status === 'PENDING');
    };
    await expect.poll(async () => (await pending()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    filedId = (await pending())[0].id;

    settle(problems, 'filing overtime');
  });

  test('the employee cannot approve their own claim', async ({ page, problems }) => {
    test.skip(!filedId, 'the filing step did not produce an id');

    const detail = new OvertimeDetailPage(page);
    await detail.open(filedId!);
    await detail.expectStatus('PENDING');

    expect(await detail.canApprove(), 'an employee was offered approval on their own overtime').toBe(false);

    settle(problems, 'an employee viewing their own overtime');
  });
});

test.describe('HR decides an overtime claim', () => {
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

    const mk = async (offset: number, tag: string) => {
      const day = futureDate(offset);
      const created = await employeeApi.post<Overtime>('/overtime', {
        date: day,
        startTime: `${day}T19:00:00.000Z`,
        endTime: `${day}T22:00:00.000Z`,
        // The DTO requires it; the browser form derives it from the range.
        hours: 3,
        reason: `Automated journey ${marker} — ${tag}`,
      });
      return created.id;
    };

    approveId = await mk(90, 'approval half');
    rejectId = await mk(120, 'rejection half');
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
  });

  test('HR approves, and the record moves with the screen', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const detail = new OvertimeDetailPage(page);
    await detail.open(approveId);
    await detail.expectStatus('PENDING');
    expect(await detail.canApprove(), 'HR was not offered the approval controls').toBe(true);

    await detail.approve();
    await detail.expectStatus('APPROVED');

    const record = await employeeApi.get<Overtime>(`/overtime/${approveId}`);
    expect(record.status).toBe('APPROVED');

    settle(problems, 'approving overtime');
  });

  test('the approved claim shows as approved in the list it feeds', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const list = new OvertimeListPage(page);
    await list.open();

    expect(await list.hasRow(approveId), 'the approved claim vanished from the list').toBe(true);
    await expect.poll(() => list.rowStatus(approveId), { timeout: 15_000 }).toBe('APPROVED');

    settle(problems, 'the overtime list after approval');
  });

  test('rejection stores its reason', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const detail = new OvertimeDetailPage(page);
    await detail.open(rejectId);
    await detail.reject(`Rejected by the automated journey ${marker}`);
    await detail.expectStatus('REJECTED');

    const record = await employeeApi.get<Overtime & { rejectedReason?: string }>(`/overtime/${rejectId}`);
    expect(record.status).toBe('REJECTED');
    expect(record.rejectedReason, 'the rejection reason was not stored').toContain(marker);

    settle(problems, 'rejecting overtime');
  });

  test('a settled claim offers no further decision', async ({ page, problems }) => {
    await selectBranch(page, branchId);
    const detail = new OvertimeDetailPage(page);
    await detail.open(approveId);
    expect(await detail.canApprove(), 'a settled claim still offered approval').toBe(false);

    settle(problems, 'a settled overtime claim');
  });
});
