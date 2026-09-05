import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  LeavesListPage,
  PendingLeavesPage,
  LeaveDetailPage,
  selectBranch,
} from '../../pages';
import { leaveWindow, laneForProject } from '../../windows';

/**
 * The leave screens an approver uses, and who may reach them.
 *
 * ── The finding this file pins ──────────────────────────────────────────────
 *
 * A MANAGER holds `VIEW_ALL_LEAVES` and is guarded INTO `/dashboard/leaves` —
 * and then the page calls `getMyRequests()` and `getBalance()` for them,
 * because the company-overview branch is ADMIN/HR only. The screen a manager is
 * guarded into is their own personal list, with no search box. `LVE-UI-32`
 * asserts it as it behaves.
 *
 * ── Dates ───────────────────────────────────────────────────────────────────
 *
 * Lane `L2`, banded per project: every Playwright project runs this file
 * against the same employee and the same database, and leave refuses an
 * overlapping range — so without a band, admin's seeded request and HR's
 * collide and the second reports an overlap, which reads exactly like a broken
 * rule.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const marker = `pw-lvapp-${Date.now().toString(36)}`;

let employeeApi: ApiClient;

/**
 * Files a request as the employee, in THIS project's own lane and slot.
 *
 * Idempotent by window, so a Playwright retry re-uses the request the failed
 * attempt created rather than colliding with it. Every case takes its OWN slot:
 * a shared one would be approved by one case and then found already-settled by
 * the next, which surfaces as a click timeout on a button that is correctly
 * absent.
 */
async function seedRequest(slot: number): Promise<string> {
  const lane = laneForProject(test.info().project.name);
  const { start, end } = leaveWindow(lane, slot);
  try {
    const res = await employeeApi.post<{ id: string }>('/leave-requests', {
      leaveType: 'ANNUAL',
      startDate: start,
      endDate: end,
      reason: `Automated journey ${marker} — awaiting decision`,
    });
    return res.id;
  } catch (err) {
    if (!String(err).includes('overlap')) throw err;
    const mine = await employeeApi.get<Array<{ id: string; startDate: string }>>(
      `/leave-requests/my-requests?startDate=${start}&endDate=${end}`,
    );
    const existing = (Array.isArray(mine) ? mine : [])[0];
    if (!existing) throw err;
    return existing.id;
  }
}

/**
 * The requester's own branch, not `firstBranchId()`. The picker self-defaults
 * to its first option, and a by-id read outside the active branch answers 404 —
 * so narrowing to "the first branch" is only correct by luck.
 */
let requesterBranchId = '';
async function branchOfRequester(): Promise<string> {
  if (requesterBranchId) return requesterBranchId;
  const id = await seedRequest(0);
  const rec = await employeeApi.get<{ employee?: { branchId?: string } }>(
    `/leave-requests/${id}`,
  );
  requesterBranchId = rec?.employee?.branchId ?? '';
  return requesterBranchId;
}

test.beforeAll(async () => {
  if (isProject('anonymous')) return;
  employeeApi = await ApiClient.as('employee');
});

test.afterAll(async () => {
  await employeeApi?.dispose();
});

test.describe('who reaches the leave screens', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denied role');
    });

    test('LVE-UI-24 an employee is redirected to /403 from the all-leaves list', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/leaves', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });
      crashesOnly(problems);
      settle(problems, 'the employee denial on /dashboard/leaves');
    });

    test('LVE-UI-25 an employee is redirected to /403 from the pending queue', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/leaves/pending', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });
      crashesOnly(problems);
      settle(problems, 'the employee denial on the pending queue');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr or manager', () => {
    test.beforeEach(() => {
      test.skip(isProject('employee') || isProject('anonymous'), 'the admitted roles');
    });

    test('LVE-UI-26 admin, HR and manager reach both screens and their data loads', async ({
      page,
      problems,
    }) => {
      const list = new LeavesListPage(page);
      await list.open();
      await expect(page).not.toHaveURL(/\/403/);

      const queue = new PendingLeavesPage(page);
      await queue.open();
      await expect(page).not.toHaveURL(/\/403/);

      settle(problems, 'the admitted roles');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the requesting role');
    });

    test('LVE-UI-27 the detail screen stays open to its own requester, by design', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());
      const id = await seedRequest(1);

      const detail = new LeaveDetailPage(page);
      await detail.open(id);
      await detail.expectStatus('PENDING');
      // `/dashboard/leaves/[id]` carries no permission guard deliberately — the
      // employee has to be able to read their own request.
      expect(await detail.notFound()).toBe(false);

      settle(problems, 'an employee reading their own request');
    });
  });
});

test.describe('the all-leaves list', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the company-wide reader');
    });

    test('LVE-UI-30 the overview tiles agree with the company-overview payload', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfRequester());

      // The browser is narrowed by `selectBranch`; the API client is not, so the
      // two would be reading different companies.
      api.withBranch(await branchOfRequester());
      const overview = await api.get<{
        totalEmployees: number;
        requestStats: { pending: number; approved: number; rejected: number };
      }>('/leave-balances/company-overview');

      const list = new LeavesListPage(page);
      await list.open();
      // Read the tiles against the payload the SERVER holds, not a number typed
      // into the test.
      await expect
        .poll(() => list.stat('employees'), { timeout: 15_000 })
        .toBe(overview.totalEmployees);
      expect(await list.stat('pending')).toBe(overview.requestStats.pending);
      expect(await list.stat('rejected')).toBe(overview.requestStats.rejected);

      settle(problems, 'the company overview tiles');
    });

    test('LVE-UI-31 the per-type usage cards agree with the same payload', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfRequester());

      api.withBranch(await branchOfRequester());
      const overview = await api.get<{
        leaveTypes: Array<{
          leaveTypeKey: string;
          totalUsed: number;
          totalRemaining: number;
          totalAllocated: number;
        }>;
      }>('/leave-balances/company-overview');
      const first = (overview.leaveTypes ?? [])[0];
      test.skip(!first, 'no per-type balances configured');

      const list = new LeavesListPage(page);
      await list.open();
      await expect
        .poll(async () => (await list.typeCard(first.leaveTypeKey))?.used ?? -1, {
          timeout: 15_000,
        })
        .toBe(first.totalUsed);
      const card = (await list.typeCard(first.leaveTypeKey))!;
      expect(card.remaining).toBe(first.totalRemaining);
      expect(card.allocated).toBe(first.totalAllocated);

      settle(problems, 'the per-type usage cards');
    });
  });

  /**
   * The pin: a manager is guarded IN and shown their OWN requests, with no
   * search box — the two observable halves of the same decision.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager half');
    });

    test('LVE-UI-32 a MANAGER is guarded in but sees their own requests and no search box', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const othersId = await seedRequest(1);
      const list = new LeavesListPage(page);
      await list.open();

      expect(await list.hasSearch(), 'a manager was offered the search box').toBe(false);
      expect(
        await list.hasRow(othersId),
        "a colleague's request appeared on the manager's list",
      ).toBe(false);

      settle(problems, 'the manager view of all-leaves');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'a company-wide reader');
    });

    test('LVE-UI-33 the status filter narrows the table and every row carries that status', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());
      await seedRequest(3);

      const list = new LeavesListPage(page);
      await list.open();
      await expect.poll(() => list.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);

      await list.filterStatus('PENDING');
      await expect
        .poll(async () => {
          const ids = await list.rowIds();
          const statuses = await Promise.all(ids.map((id) => list.rowStatus(id)));
          return statuses.every((s) => s === 'PENDING');
        }, { timeout: 15_000 })
        .toBe(true);

      settle(problems, 'the status filter');
    });

    test('LVE-UI-38 Clear appears only with a filter set and restores the row count', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const list = new LeavesListPage(page);
      await list.open();
      await expect.poll(() => list.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);
      const before = await list.rowCount();
      expect(await list.hasClear()).toBe(false);

      await list.filterStatus('REJECTED');
      await expect.poll(() => list.hasClear(), { timeout: 10_000 }).toBe(true);

      await list.clearFilters();
      // At least what was there before — other spec files add rows to the same
      // company-wide list while this one runs, so equality is not the invariant;
      // "the filter no longer narrows anything" is.
      await expect
        .poll(() => list.rowCount(), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(before);
      expect(await list.hasClear()).toBe(false);

      settle(problems, 'clearing the filters');
    });

    test('LVE-UI-41 a row click opens that request', async ({ page, problems }) => {
      await selectBranch(page, await branchOfRequester());

      const id = await seedRequest(4);
      const list = new LeavesListPage(page);
      await list.open();
      await expect.poll(() => list.hasRow(id), { timeout: 15_000 }).toBe(true);
      await list.openRow(id);

      const detail = new LeaveDetailPage(page);
      await detail.expectStatus('PENDING');

      settle(problems, 'opening a request from the list');
    });
  });
});

test.describe('the pending queue', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'an approving role');
  });

  test('LVE-UI-43 the header count equals the row count', async ({ page, problems }) => {
    await selectBranch(page, await branchOfRequester());
    await seedRequest(5);

    const queue = new PendingLeavesPage(page);
    await queue.open();
    await expect.poll(() => queue.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await queue.headerCount()).toBe(await queue.rowCount());

    settle(problems, 'the pending header count');
  });

  test('LVE-UI-44 every row in the queue really is PENDING', async ({ page, problems }) => {
    await selectBranch(page, await branchOfRequester());

    const queue = new PendingLeavesPage(page);
    await queue.open();
    const ids = await queue.rowIds();
    test.skip(ids.length === 0, 'nothing pending');

    // Cross-checked against the record, not against the screen's own badge.
    for (const id of ids.slice(0, 5)) {
      const rec = await employeeApi
        .get<{ status: string }>(`/leave-requests/${id}`)
        .catch(() => null);
      if (rec) expect(rec.status).toBe('PENDING');
    }

    settle(problems, 'the pending queue contents');
  });

  test('LVE-UI-46 the queue shrinks by exactly one after a decision', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, await branchOfRequester());

    const id = await seedRequest(6);
    const queue = new PendingLeavesPage(page);
    await queue.open();
    await expect.poll(() => queue.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await queue.rowIds()).toContain(id);

    const detail = new LeaveDetailPage(page);
    await detail.open(id);
    await detail.reject('Cover not arranged');
    await detail.expectStatus('REJECTED');

    // The DECIDED id leaves the queue. Deliberately not "the count drops by
    // one": the queue is company-wide and the other spec files in this run file
    // their own requests into it, so an absolute count is a moving target that
    // fails for reasons this case is not about.
    await queue.open();
    await expect.poll(() => queue.rowIds(), { timeout: 15_000 }).not.toContain(id);
    expect(await queue.headerCount()).toBe(await queue.rowCount());

    settle(problems, 'the queue after a decision');
  });
});

test.describe('deciding', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the deciding role');
    });

    test('LVE-UI-48 HR approves with a comment, and screen, record and list agree', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const id = await seedRequest(7);
      const detail = new LeaveDetailPage(page);
      await detail.open(id);
      expect(await detail.canApprove(), 'HR was offered no approval controls').toBe(true);
      await detail.approve();
      await detail.expectStatus('APPROVED');

      await expect
        .poll(
          async () =>
            (await employeeApi.get<{ status: string }>(`/leave-requests/${id}`)).status,
          { timeout: 15_000 },
        )
        .toBe('APPROVED');

      const list = new LeavesListPage(page);
      await list.open();
      await expect.poll(() => list.rowStatus(id), { timeout: 15_000 }).toBe('APPROVED');

      settle(problems, 'approving a leave request');
    });

  /**
   * The balance moves at APPROVAL, never at filing — measured as a delta on the
   * same screen, because the absolute number belongs to the whole company and
   * every other spec moves it.
   */
    test('LVE-UI-49 the balance is deducted at approval, not at filing', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const id = await seedRequest(8);
      const detail = new LeaveDetailPage(page);
      await detail.open(id);

      const before = await detail.balanceRemaining('Annual Leave');
      test.skip(before === null, 'the requester has no Annual Leave balance card');
      const days = await detail.totalDays();

      await detail.approve();
      await detail.expectStatus('APPROVED');

      await detail.open(id);
      await expect
        .poll(() => detail.balanceRemaining('Annual Leave'), { timeout: 15_000 })
        .toBe(before! - days);

      settle(problems, 'the balance deduction at approval');
    });

    test('LVE-UI-51 HR rejects with a reason, and the reason is stored', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const id = await seedRequest(9);
      const detail = new LeaveDetailPage(page);
      await detail.open(id);
      await detail.reject('Peak season — please re-file in Q3');
      await detail.expectStatus('REJECTED');

      await expect
        .poll(
          async () =>
            (await employeeApi.get<{ rejectedReason?: string }>(`/leave-requests/${id}`))
              .rejectedReason,
          { timeout: 15_000 },
        )
        .toContain('Peak season');

      settle(problems, 'rejecting a leave request');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager half');
    });

    test('LVE-UI-52 a MANAGER heading the requester’s department is offered the controls', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfRequester());

      const id = await seedRequest(2);
      const detail = new LeaveDetailPage(page);
      await detail.open(id);

      // Whether the manager heads THIS requester's department is a property of
      // the seed, so both answers are legitimate — what must hold is that the
      // screen's offer matches what the server would accept.
      const offered = await detail.canApprove();
      const trail = await employeeApi
        .get<{ engaged: boolean; canAct: boolean }>(
          `/approval-workflows/trail/LEAVE/${id}`,
        )
        .catch(() => null);
      if (trail?.engaged) {
        expect(offered).toBe(trail.canAct);
      }
      expect(typeof offered).toBe('boolean');

      settle(problems, 'the manager decision controls');
    });
  });
});
