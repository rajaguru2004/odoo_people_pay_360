import { test, expect, settle, ApiClient } from '../../fixtures';
import { LeaveDetailPage, LeaveRequestPage, MyLeavesPage } from '../../pages';

/**
 * Leave, end to end, across two roles.
 *
 * Mirrors step 5 of `apps/backend/test/live/full-lifecycle.live-e2e.ts` — the
 * backend's own definition of the critical path — but through the browser,
 * which is the half that suite cannot see.
 *
 * The shape that matters is the hand-off: an employee files a request, an
 * approver acts on it, and the employee sees the result. Each half is fine on
 * its own and the flow can still be broken between them, which is exactly the
 * failure a per-screen test misses.
 *
 * This file WRITES. It runs serially so two workers cannot approve the same
 * request, and every request it creates is tagged in its reason text so a
 * half-finished run is recognisable in the database.
 */

test.describe.configure({ mode: 'serial' });

/** True when the current project is the role this block is written for. */
const isProject = (name: string) => test.info().project.name === name;

/** Distinct per run, and visible in the UI, so leftovers are identifiable. */
const marker = `pw-leave-${Date.now().toString(36)}`;

/**
 * A three-day range comfortably in the future — the form refuses the past.
 *
 * The base offset is nudged by a per-run amount because the backend rejects a
 * request that overlaps an existing one ("Leave request overlaps with existing
 * request"). Fixed dates therefore only work on a freshly reset database, and
 * this file would fail the second time anyone ran it without one. The window is
 * wide enough that consecutive runs cannot collide, and far enough out that it
 * never touches the seeded month the payroll journeys rely on.
 */
const RUN_NUDGE = Date.now() % 180;

function futureRange(offsetDays: number): { start: string; end: string } {
  const start = new Date(Date.now() + (offsetDays + RUN_NUDGE) * 86_400_000);
  const end = new Date(start.getTime() + 2 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

test.describe('a leave request from filing to decision', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'employee half of the journey');
  });

  let leaveId: string;

  test('an employee files a request', async ({ page, problems }) => {
    const form = new LeaveRequestPage(page);
    const { start, end } = futureRange(200);

    await form.open();
    await form.submit({
      startDate: start,
      endDate: end,
      reason: `Automated journey ${marker} — family commitment abroad`,
    });
    await form.expectSubmitted();

    const list = new MyLeavesPage(page);
    await list.open();
    const id = await list.firstRequestId();
    expect(id, 'the new request did not appear in my-leaves').toBeTruthy();
    leaveId = id!;

    settle(problems, 'filing a leave request');
  });

  test('it starts life PENDING, and the employee cannot approve their own', async ({ page, problems }) => {
    test.skip(!leaveId, 'the filing step did not produce an id');

    const detail = new LeaveDetailPage(page);
    await detail.open(leaveId);

    await detail.expectStatus('PENDING');
    // Self-approval is the thing that must never be possible, whatever the
    // approval chain is configured to do.
    expect(await detail.canApprove(), 'an employee was offered approval controls').toBe(false);

    settle(problems, 'the employee view of a pending request');
  });
});

/**
 * The approver's half. Runs in the hr project, and creates its own request over
 * the API rather than depending on the employee project having run first —
 * Playwright projects do not share state, so a cross-project dependency would
 * make this file order-sensitive and fragile.
 */
test.describe('an approver acts on a request', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'approver half of the journey');
  });

  test.describe.configure({ mode: 'serial' });

  let seededLeaveId: string;
  let employeeApi: ApiClient;

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    employeeApi = await ApiClient.as('employee');
    const { start, end } = futureRange(240);
    const created = await employeeApi.post<{ id: string }>('/leave-requests', {
      leaveType: 'Annual Leave',
      startDate: start,
      endDate: end,
      reason: `Automated journey ${marker} — approver half`,
    });
    seededLeaveId = created.id;
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
  });

  test('HR sees the pending request and approves it', async ({ page, problems }) => {
    const detail = new LeaveDetailPage(page);
    await detail.open(seededLeaveId);
    await detail.expectStatus('PENDING');

    expect(await detail.canApprove(), 'HR was not offered the approval controls').toBe(true);
    await detail.approve();

    // The status is the whole point: a screen that says "approved" while the
    // record stays PENDING is the failure this catches.
    await detail.expectStatus('APPROVED');

    settle(problems, 'approving a leave request');
  });

  test('the decision is visible over the API, not just on screen', async () => {
    // Guards against a UI that updates its own state optimistically and never
    // persists — the screen would look right and the record would be wrong.
    const record = await employeeApi.get<{ status: string }>(`/leave-requests/${seededLeaveId}`);
    expect(record.status).toBe('APPROVED');
  });

  test('an approved request can no longer be approved again', async ({ page, problems }) => {
    const detail = new LeaveDetailPage(page);
    await detail.open(seededLeaveId);

    await detail.expectStatus('APPROVED');
    expect(await detail.canApprove(), 'a settled request still offered approval').toBe(false);

    settle(problems, 'a settled leave request');
  });
});

test.describe('rejection', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'approver half of the journey');
  });

  test.describe.configure({ mode: 'serial' });

  let leaveId: string;
  let employeeApi: ApiClient;

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    employeeApi = await ApiClient.as('employee');
    const { start, end } = futureRange(280);
    const created = await employeeApi.post<{ id: string }>('/leave-requests', {
      leaveType: 'Annual Leave',
      startDate: start,
      endDate: end,
      reason: `Automated journey ${marker} — rejection half`,
    });
    leaveId = created.id;
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
  });

  test('HR rejects with a reason, and the record follows', async ({ page, problems }) => {
    const detail = new LeaveDetailPage(page);
    await detail.open(leaveId);
    await detail.reject(`Rejected by the automated journey ${marker}`);

    await detail.expectStatus('REJECTED');

    const record = await employeeApi.get<{ status: string }>(`/leave-requests/${leaveId}`);
    expect(record.status).toBe('REJECTED');

    settle(problems, 'rejecting a leave request');
  });
});
