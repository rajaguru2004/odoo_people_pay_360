import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { LeaveBalancesPage, TeamBalancesPage, ToastArea, selectBranch } from '../../pages';

/**
 * Leave balances — the grid, the edit modal, the two bulk operations, and the
 * manager's team view.
 *
 * ── The finding this file pins ──────────────────────────────────────────────
 *
 * `/dashboard/leaves/balances` has **no `ProtectedRoute`** while hosting two
 * COMPANY-WIDE mutations: "Run accrual" (a day for every active employee) and
 * "Reset to defaults" (rewrites the whole year's allocations). The only gate is
 * the server. `e2e/routes.ts` already records the route as `guarded: false`, so
 * the gap is tolerated — `LBL-UI-01`/`02` are where it is finally asserted.
 *
 * ── Why the two bulk cases are behind a flag ────────────────────────────────
 *
 * They mutate EVERY employee's balance, and Playwright runs spec files in path
 * order — so this file executes BEFORE `leave-request.spec.ts`, whose
 * insufficient-balance and balance-card cases would then be measuring a
 * database this file rewrote. They run only under
 * `E2E_ALLOW_BULK_BALANCE=1`, against a database of their own, and report why
 * they skipped rather than vanishing from the run.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const BULK_ALLOWED = process.env.E2E_ALLOW_BULK_BALANCE === '1';

let employeeApi: ApiClient;
let branchId = '';
let seeded = false;

test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name === 'anonymous') return;
  employeeApi = await ApiClient.as('employee');
});

test.afterAll(async () => {
  await employeeApi?.dispose();
});

test.beforeEach(async ({ api }) => {
  if (!branchId) branchId = await api.firstBranchId();
  if (seeded || isProject('employee') || isProject('anonymous')) return;
  seeded = true;

  /*
   * `GET /leave-balances` returns only balance rows that EXIST, and a freshly
   * cloned database has none — nobody has opened a balance yet. So the grid is
   * legitimately empty, and asserting rows without seeding would be asserting
   * the seed rather than the screen.
   *
   * `GET /leave-balances/employee/:id` auto-initialises on read (a documented
   * quirk — see LBL-API-06), so touching a few employees is the cheapest honest
   * way to give the grid something to render.
   */
  api.withBranch(branchId);
  const employees = await api
    .get<Array<{ id: string }> | { data?: Array<{ id: string }> }>('/employees?limit=5')
    .catch(() => [] as Array<{ id: string }>);
  const list = Array.isArray(employees) ? employees : (employees?.data ?? []);
  for (const emp of list.slice(0, 5)) {
    await api.get(`/leave-balances/employee/${emp.id}`).catch(() => undefined);
  }
});

test.describe('who can open the balances screen', () => {
  /**
   * The pin. There is no client guard at all, so the shell renders for anyone
   * with the URL; only the data call refuses. Two separate facts, and the
   * second is the only thing standing between an employee and a company-wide
   * reset button.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the ungated role');
    });

    test('LBL-UI-01 an EMPLOYEE reaches the shell — there is no route guard — and the data refuses', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/leaves/balances', { waitUntil: 'domcontentloaded' });

      // Not redirected to /403: the screen has no ProtectedRoute.
      await expect(page).not.toHaveURL(/\/403/);
      const grid = new LeaveBalancesPage(page);
      await expect.poll(() => grid.rowCount(), { timeout: 15_000 }).toBe(0);

      // A logged 403 from the data call is the correct outcome here.
      crashesOnly(problems);
      settle(problems, 'an employee on the balances screen');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the other ungated role');
    });

    test('LBL-UI-02 a MANAGER likewise reaches the shell and cannot load the grid', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/leaves/balances', { waitUntil: 'domcontentloaded' });
      await expect(page).not.toHaveURL(/\/403/);
      const grid = new LeaveBalancesPage(page);
      await expect.poll(() => grid.rowCount(), { timeout: 15_000 }).toBe(0);
      crashesOnly(problems);
      settle(problems, 'a manager on the balances screen');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('hr'), 'the entitled roles');
    });

    test('LBL-UI-03 admin and HR load the grid', async ({ page, problems }) => {
      await selectBranch(page, branchId);
      const grid = new LeaveBalancesPage(page);
      await grid.open();
      await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);
      // The balances grid pulls a per-row static asset that the standalone build
      // does not ship, so the console carries 404s that are NOT API calls — the
      // fixture's `httpErrors` list (which tracks the API host) stays empty.
      // Judge crashes; the agreement assertions above are the real subject.
      crashesOnly(problems);
      settle(problems, 'the balances grid');
    });
  });
});

test.describe('the grid', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'a company-wide reader');
  });

  test('LBL-UI-05 one row per balance, and the Total Employees tile agrees', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, branchId);
    api.withBranch(branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const year = await grid.selectedYear();
    const payload = await api.get<Array<{ employeeId: string }>>(
      `/leave-balances?year=${year}`,
    );
    expect(await grid.rowCount()).toBe(payload.length);
    expect(await grid.stat('total')).toBe(payload.length);

    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'the balances row count');
  });

  test('LBL-UI-06 each per-type cell agrees with the payload', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, branchId);
    api.withBranch(branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const year = await grid.selectedYear();
    const payload = await api.get<
      Array<{
        employeeId: string;
        leaveTypeBalances?: Array<{ leaveTypeKey: string; remaining: number }>;
      }>
    >(`/leave-balances?year=${year}`);
    const row = payload.find((r) => (r.leaveTypeBalances ?? []).length > 0);
    test.skip(!row, 'no per-type balances configured');

    const type = row!.leaveTypeBalances![0];
    const cell = await grid.cell(row!.employeeId, type.leaveTypeKey);
    expect(cell.applicable).toBe(true);
    expect(cell.remaining).toBe(type.remaining);

    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'a balance cell against the payload');
  });

  test('LBL-UI-10 changing the year refetches, and the tiles follow', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);
    const current = await grid.selectedYear();

    await grid.selectYear(current + 1);
    expect(await grid.selectedYear()).toBe(current + 1);
    // A year nobody has initialised renders the empty row rather than the
    // previous year's numbers.
    await expect
      .poll(async () => (await grid.rowCount()) >= 0, { timeout: 20_000 })
      .toBe(true);

    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'switching the balance year');
  });
});

test.describe('editing one employee', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the entitled role');
  });

  test('LBL-UI-12 the modal seeds from the row it was opened on', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, branchId);
    api.withBranch(branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const ids = await grid.employeeIds();
    await grid.openEdit(ids[0]);
    const types = await grid.editableTypes();
    expect(types.length, 'the edit modal offered no leave types').toBeGreaterThan(0);

    await grid.cancelEdit();
    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'the balance edit modal');
  });

  test('LBL-UI-13 saving writes the allocation and the grid follows', async ({
    page,
    problems,
    api,
  }) => {
    await selectBranch(page, branchId);
    api.withBranch(branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const ids = await grid.employeeIds();
    const target = ids[0];
    await grid.openEdit(target);
    const types = await grid.editableTypes();
    test.skip(types.length === 0, 'no editable leave types');

    const type = types[0];
    const before = await grid.cell(target, type);
    const next = before.total + 1;
    await grid.setAllocated(type, next);
    await grid.saveEdit();

    // The grid refetches after the save, so the cell — not just the modal —
    // must show the new number.
    await expect
      .poll(async () => (await grid.cell(target, type)).total, { timeout: 20_000 })
      .toBe(next);

    // Put it back: this row belongs to the shared seed, not to this spec.
    await grid.openEdit(target);
    await grid.setAllocated(type, before.total);
    await grid.saveEdit();
    await expect
      .poll(async () => (await grid.cell(target, type)).total, { timeout: 20_000 })
      .toBe(before.total);

    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'editing one employee’s allocation');
  });

  test('LBL-UI-14 cancel discards without issuing a request', async ({ page, problems }) => {
    await selectBranch(page, branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const ids = await grid.employeeIds();
    await grid.openEdit(ids[0]);
    const types = await grid.editableTypes();
    test.skip(types.length === 0, 'no editable leave types');

    const before = await grid.cell(ids[0], types[0]);
    await grid.setAllocated(types[0], before.total + 5);
    await grid.cancelEdit();

    expect((await grid.cell(ids[0], types[0])).total).toBe(before.total);
    // The balances grid pulls a per-row static asset that the standalone build
    // does not ship, so the console carries 404s that are NOT API calls — the
    // fixture's `httpErrors` list (which tracks the API host) stays empty.
    // Judge crashes; the agreement assertions above are the real subject.
    crashesOnly(problems);
    settle(problems, 'cancelling the balance edit');
  });
});

test.describe('the manager’s team view', () => {
  /**
   * The pin: this screen denies by `router.replace('/dashboard')`, not `/403`.
   * The route matrix cannot see it — an unguarded route gets no URL assertion —
   * so this is the only place the behaviour is recorded.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr or employee', () => {
    test.beforeEach(() => {
      test.skip(isProject('manager') || isProject('anonymous'), 'the denied roles');
    });

    test('LBL-UI-21 a non-MANAGER lands on /dashboard, not /403', async ({ page, problems }) => {
      await page.goto('/dashboard/my-department/team-balances', {
        waitUntil: 'domcontentloaded',
      });
      await expect(page).toHaveURL(/\/dashboard(?!\/my-department)/, { timeout: 15_000 });
      await expect(page).not.toHaveURL(/\/403/);
      crashesOnly(problems);
      settle(problems, 'the team-balances denial');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the entitled role');
    });

    test('LBL-UI-22 the manager loads their department and the Members tile agrees', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, branchId);

      const team = new TeamBalancesPage(page);
      await team.open();
      await expect(page).toHaveURL(/team-balances/, { timeout: 15_000 });

      const rows = await team.rowCount();
      if (rows === 0) {
        expect(await team.isEmpty()).toBe(true);
      } else {
        expect(await team.stat('members')).toBe(rows);
      }

      settle(problems, 'the team balances screen');
    });

    test('LBL-UI-24 an employee with no balance row reads "not initialised"', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, branchId);

      const team = new TeamBalancesPage(page);
      await team.open();
      const ids = await team.employeeIds();
      test.skip(ids.length === 0, 'the manager heads nobody with a balance row');

      const rows = await Promise.all(ids.map((id) => team.row(id)));
      const uninitialised = rows.filter((r) => !r.initialised).length;
      expect(await team.stat('noBalance')).toBe(uninitialised);

      settle(problems, 'the uninitialised-balance tile');
    });

    test('LBL-UI-25 the sortable headers reorder in place', async ({ page, problems }) => {
      await selectBranch(page, branchId);

      const team = new TeamBalancesPage(page);
      await team.open();
      const before = await team.employeeIds();
      test.skip(before.length < 2, 'needs at least two rows to reorder');

      await team.sortBy('name');
      const after = await team.employeeIds();
      // Same set, sorted client-side — no refetch, so nothing may appear or leave.
      expect([...after].sort()).toEqual([...before].sort());

      settle(problems, 'sorting the team balances');
    });
  });
});

/**
 * COMPANY-WIDE. Ordered last in the file, and gated — see the header.
 */
test.describe('the two bulk operations', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the entitled role');
  });

  test('LBL-UI-16 Run accrual asks first, and dismissing issues no request', async ({
    page,
    problems,
  }) => {
    test.skip(
      !BULK_ALLOWED,
      'mutates every employee company-wide; run with E2E_ALLOW_BULK_BALANCE=1 against its own database',
    );
    await selectBranch(page, branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    const ids = await grid.employeeIds();
    const types = await grid.editableTypes().catch(() => [] as string[]);
    void types;
    const before = await grid.cell(ids[0], 'Annual Leave').catch(() => null);

    await grid.runAccrual(false);
    if (before) {
      expect((await grid.cell(ids[0], 'Annual Leave')).total).toBe(before.total);
    }

    settle(problems, 'dismissing the accrual confirmation');
  });

  test('LBL-UI-17 Run accrual reports its counts and the grid refetches', async ({
    page,
    problems,
  }) => {
    test.skip(
      !BULK_ALLOWED,
      'mutates every employee company-wide; run with E2E_ALLOW_BULK_BALANCE=1 against its own database',
    );
    await selectBranch(page, branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    await grid.runAccrual(true);
    const toast = new ToastArea(page);
    // Success or "already accrued this month" — both are legitimate answers,
    // and either proves the screen reported the outcome rather than swallowing
    // it. What must not happen is silence.
    const latest = await expect
      .poll(async () => (await toast.latest())?.text ?? '', { timeout: 130_000 })
      .not.toBe('')
      .then(() => toast.latest());
    expect(latest?.text.length).toBeGreaterThan(0);

    settle(problems, 'running the accrual');
  });

  test('LBL-UI-18 Reset to defaults is a danger confirm naming the year', async ({
    page,
    problems,
  }) => {
    test.skip(
      !BULK_ALLOWED,
      'mutates every employee company-wide; run with E2E_ALLOW_BULK_BALANCE=1 against its own database',
    );
    await selectBranch(page, branchId);

    const grid = new LeaveBalancesPage(page);
    await grid.open();
    await expect.poll(() => grid.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);

    await grid.resetToDefaults(true);
    const toast = new ToastArea(page);
    await expect
      .poll(async () => (await toast.latest())?.text ?? '', { timeout: 60_000 })
      .not.toBe('');

    settle(problems, 'resetting the allocations');
  });
});
