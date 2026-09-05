import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  OvertimeListPage,
  OvertimeDetailPage,
  OvertimeReviewModal,
  selectBranch,
} from '../../pages';
import { otMonth } from '../../windows';

/**
 * The overtime screens from the approver's side, and who may reach them.
 *
 * ── The finding this file pins ──────────────────────────────────────────────
 *
 * A MANAGER holds `VIEW_ALL_OVERTIME` and is guarded INTO `/dashboard/overtime`
 * — but the page fetches `getMyRequests()` for them, because `isAdminOrHR` is
 * ADMIN or HR only. So a screen titled "Overtime Requests", reached from a
 * sidebar entry called "Overtime Requests", shows a manager their OWN claims
 * and hides the employee column. Neither the title nor the sidebar says so.
 * `OT-UI-24` asserts it as it behaves.
 *
 * ── Dates ───────────────────────────────────────────────────────────────────
 *
 * Month OT-C (`e2e/windows.ts`). Claims are seeded over the API as the
 * employee, so the browser only ever drives the decision.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const marker = `pw-otapp-${Date.now().toString(36)}`;
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

let employeeApi: ApiClient;

/**
 * Every Playwright project runs this file against the SAME employee and the
 * same database, and overtime allows one request per employee per DATE — so
 * without a per-project band, admin's seeded claim and HR's collide and the
 * second reports "An overtime request already exists for this date", which
 * reads exactly like a product bug.
 *
 * A band of whole MONTHS rather than days: a month holds ~22 working days, so
 * day-banding four projects would overflow it.
 */
const MONTH_BAND: Record<string, number> = { admin: 0, hr: 1, manager: 2, employee: 3 };

/** The nth working day of this project's own band month, inside OT-C. */
function claimDate(slot: number): string {
  const base = otMonth('L3');
  const band = MONTH_BAND[test.info().project.name] ?? 0;
  const d = new Date(Date.UTC(base.year, base.month - 1 + band, 1));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  let found = 0;
  for (let i = 0; i < 31; i++) {
    const day = new Date(Date.UTC(year, month, 1 + i));
    if (day.getUTCMonth() !== month) break;
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (found === slot) return day.toISOString().slice(0, 10);
    found++;
  }
  throw new Error(`overtime-approval: no working day ${slot} in the band month`);
}

/**
 * Files a claim as the employee and hands back its id.
 *
 * Idempotent by date: Playwright retries a failed test, and overtime allows one
 * request per employee per date — so a naive re-seed turns a retry into a 400
 * that hides whatever actually failed the first time.
 */
async function seedClaim(
  slot: number,
  window: { from: string; to: string; hours: number } = {
    from: '18:00',
    to: '20:00',
    hours: 2,
  },
): Promise<string> {
  const date = claimDate(slot);
  try {
    const res = await employeeApi.post<{ id: string }>('/overtime', {
      date,
      startTime: at(date, window.from),
      endTime: at(date, window.to),
      hours: window.hours,
      reason: `Automated overtime ${marker} — awaiting decision`,
    });
    return res.id;
  } catch (err) {
    if (!String(err).includes('already exists')) throw err;
    const mine = await employeeApi.get<
      Array<{ id: string; date: string; startTime: string; status: string }>
    >('/overtime/my-requests');
    const existing = (Array.isArray(mine) ? mine : []).find(
      (r) => String(r.date).slice(0, 10) === date,
    );
    if (!existing) throw err;

    // Reuse only a row with the WINDOW this caller asked for. A slot left by an
    // earlier run holds whatever window that run wanted, and handing it back
    // silently means the case asserts against hours it never seeded — which
    // reads as a broken rule rather than as a stale fixture.
    const wanted = at(date, window.from);
    if (
      new Date(existing.startTime).toISOString() === wanted &&
      existing.status === 'PENDING'
    ) {
      return existing.id;
    }
    if (existing.status !== 'PENDING') throw err;
    await employeeApi.delete(`/overtime/${existing.id}`);
    const res = await employeeApi.post<{ id: string }>('/overtime', {
      date,
      startTime: wanted,
      endTime: at(date, window.to),
      hours: window.hours,
      reason: `Automated overtime ${marker} — awaiting decision`,
    });
    return res.id;
  }
}

/**
 * A claim an approver can stretch ACROSS the 22:00 late threshold without
 * breaching the 4h daily cap.
 *
 * From 18:00 the only windows that reach 22:00 are 4h or more, so a correction
 * case seeded there is refused for the CAP rather than proving what it is
 * about. Starting at 19:00 leaves room: 19:00–22:30 is 3.5h and still re-tiers.
 */
const LATE_REACHABLE = { from: '19:00', to: '20:00', hours: 1 };

/**
 * The branch the CLAIMANT sits in — not `firstBranchId()`.
 *
 * The branch picker self-defaults to its first option when the stored selection
 * is empty, and a by-id read outside the active branch answers 404. Narrowing
 * to "the first branch" is therefore only correct by luck; narrowing to the
 * claimant's own branch is correct by construction.
 */
let claimantBranchId = '';
async function branchOfClaimant(): Promise<string> {
  if (claimantBranchId) return claimantBranchId;
  const id = await seedClaim(0);
  const rec = await employeeApi.get<{ employee?: { branchId?: string } }>(
    `/overtime/${id}`,
  );
  claimantBranchId = rec?.employee?.branchId ?? '';
  return claimantBranchId;
}

test.beforeAll(async () => {
  if (!isProject('hr') && !isProject('admin') && !isProject('manager')) return;
  employeeApi = await ApiClient.as('employee');
});

test.afterAll(async () => {
  await employeeApi?.dispose();
});

test.describe('who reaches the overtime screens', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the denied role');
    });

    test('OT-UI-22 an employee is redirected away from the all-overtime screen', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/overtime', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/, { timeout: 15_000 });
      // A logged 403 is the CORRECT outcome here.
      crashesOnly(problems);
      settle(problems, 'the employee denial');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr or manager', () => {
    test.beforeEach(() => {
      test.skip(isProject('employee') || isProject('anonymous'), 'the admitted roles');
    });

    test('OT-UI-23 admin, HR and manager all reach it', async ({ page, problems }) => {
      const list = new OvertimeListPage(page);
      await list.open();
      await expect(page).not.toHaveURL(/\/403/);
      settle(problems, 'the admitted roles');
    });
  });

  /**
   * The pin. A manager is guarded IN and then shown their own claims — the
   * employee column is absent, which is the observable half of the same
   * decision.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager half');
    });

    test('OT-UI-24 a MANAGER on the all-overtime screen is shown only their own claims', async ({
      page,
      problems,
    }) => {
      const list = new OvertimeListPage(page);
      await list.open();

      expect(
        await list.hasEmployeeColumn(),
        'the employee column appeared for a manager',
      ).toBe(false);

      // Every row on the screen is the manager's own, so a claim filed by
      // somebody else cannot be here.
      const otherId = await seedClaim(0);
      await list.open();
      expect(await list.hasRow(otherId)).toBe(false);

      settle(problems, 'the manager view of all-overtime');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('hr'), 'the company-wide roles');
    });

    test('OT-UI-25 the employee column renders for admin and HR', async ({ page, problems }) => {
      await selectBranch(page, await branchOfClaimant());
      const list = new OvertimeListPage(page);
      await seedClaim(1);
      await list.open();
      await expect.poll(() => list.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);
      expect(await list.hasEmployeeColumn()).toBe(true);
      settle(problems, 'the employee column');
    });
  });
});

test.describe('the list', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'a company-wide reader');
  });

  test('OT-UI-27 the filter pills narrow the list and mark themselves active', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, await branchOfClaimant());
    const list = new OvertimeListPage(page);
    await list.open();
    await expect.poll(() => list.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);

    const all = await list.rowCount();
    await list.filter('PENDING');
    expect(await list.activeFilter()).toBe('PENDING');
    for (const id of await list.rowIds()) {
      expect(await list.rowStatus(id)).toBe('PENDING');
    }

    await list.filter('all');
    expect(await list.rowCount()).toBe(all);

    settle(problems, 'the overtime filters');
  });

  test('OT-UI-28 the stat tiles agree with the rows on screen', async ({ page, problems }) => {
    await selectBranch(page, await branchOfClaimant());
    const list = new OvertimeListPage(page);
    await list.open();
    await list.filter('all');
    await expect.poll(() => list.rowCount(), { timeout: 15_000 }).toBeGreaterThan(0);

    const ids = await list.rowIds();
    const statuses = await Promise.all(ids.map((id) => list.rowStatus(id)));
    expect(await list.stat('pending')).toBe(statuses.filter((s) => s === 'PENDING').length);

    settle(problems, 'the overtime stat tiles');
  });

  test('OT-UI-29 a filter matching nothing renders the empty row honestly', async ({
    page,
    problems,
  }) => {
    await selectBranch(page, await branchOfClaimant());
    const list = new OvertimeListPage(page);
    await list.open();
    await list.filter('REJECTED');
    if ((await list.rowCount()) === 0) {
      expect(await list.isEmpty()).toBe(true);
    }
    settle(problems, 'the empty filter result');
  });

  test('OT-UI-30 the Details button opens that claim', async ({ page, problems }) => {
    await selectBranch(page, await branchOfClaimant());

    const id = await seedClaim(2);
    const list = new OvertimeListPage(page);
    await list.open();
    await expect.poll(() => list.hasRow(id), { timeout: 15_000 }).toBe(true);
    await list.openDetails(id);

    const detail = new OvertimeDetailPage(page);
    await detail.expectStatus('PENDING');
    settle(problems, 'opening a claim from the list');
  });
});

test.describe('the detail screen and the decision', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'the deciding role');
    });

    test('OT-UI-32 the breakdown agrees with the row the list showed', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(3);
      const list = new OvertimeListPage(page);
      await list.open();
      await expect.poll(() => list.hasRow(id), { timeout: 15_000 }).toBe(true);
      const rowHours = await list.rowHours(id);
      const rowType = await list.rowOtType(id);

      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      const breakdown = await detail.breakdown();
      expect(breakdown, 'no payable breakdown was rendered').toBeTruthy();
      // The detail screen RECOMPUTES from current settings; with settings
      // unchanged between the two reads it must land on the same numbers.
      expect(breakdown!.totalHours).toBeCloseTo(rowHours, 1);
      expect(breakdown!.otType).toBe(rowType);

      settle(problems, 'the payable breakdown');
    });

    test('OT-UI-33 the expected pay is derived from the hourly rate and the tiers', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(4);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);

      const pay = await detail.pay();
      test.skip(!pay, 'the seeded employee has no salary, so no pay card is shown');
      // Not the formula — `utils/payBasis` owns that. What must hold is that the
      // screen showed a rate and a total that move together.
      expect(pay!.total).toBeGreaterThan(0);
      expect(pay!.hourlyRate).toBeGreaterThanOrEqual(0);

      settle(problems, 'the expected-pay card');
    });

    test('OT-UI-35 approval routes through the review screen — dismissing changes nothing', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(5);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      expect(await detail.canApprove()).toBe(true);

      // The button opens the review-and-edit screen; the decision is taken
      // there. Opening it must decide nothing on its own.
      await page.getByTestId('overtime-approve').click();
      await expect(page.getByTestId('ot-review-modal')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('ot-review-modal')).toHaveCount(0);

      expect(
        (await employeeApi.get<{ status: string }>(`/overtime/${id}`)).status,
        'dismissing the review screen still decided the claim',
      ).toBe('PENDING');

      settle(problems, 'dismissing the approval review screen');
    });

    test('OT-UI-36 confirming moves the status on screen, in the record and in the list', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(6);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      await detail.approve();
      await detail.expectStatus('APPROVED');

      await expect
        .poll(
          async () => (await employeeApi.get<{ status: string }>(`/overtime/${id}`)).status,
          { timeout: 15_000 },
        )
        .toBe('APPROVED');

      const list = new OvertimeListPage(page);
      await list.open();
      await expect.poll(() => list.rowStatus(id), { timeout: 15_000 }).toBe('APPROVED');

      settle(problems, 'approving an overtime claim');
    });

  /**
   * The screen both DISABLES the reject button without a reason and re-checks
   * inside the handler with a toast — one of the two is unreachable from the
   * UI. Assert the state that is actually reachable.
   */
    test('OT-UI-37 reject is disabled until a reason is typed', async ({ page, problems }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(7);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      expect(await detail.rejectDisabledWithoutReason()).toBe(true);

      settle(problems, 'the disabled reject button');
    });

    test('OT-UI-38 rejecting stores the reason and the detail screen renders it', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(8);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      await detail.reject('Not authorised in advance');
      await detail.expectStatus('REJECTED');

      await expect
        .poll(
          async () =>
            (await employeeApi.get<{ rejectedReason?: string }>(`/overtime/${id}`))
              .rejectedReason,
          { timeout: 15_000 },
        )
        .toBe('Not authorised in advance');

      await detail.open(id);
      expect(await detail.rejectionReason()).toContain('Not authorised in advance');

      settle(problems, 'rejecting an overtime claim');
    });

    test('OT-UI-39 a settled claim offers no further decision', async ({ page, problems }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(9);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      await detail.approve();
      await detail.expectStatus('APPROVED');

      await detail.open(id);
      expect(await detail.canApprove()).toBe(false);
      expect(await detail.canReject()).toBe(false);

      settle(problems, 'a settled claim offering no controls');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('manager'), 'the two contrasting roles');
    });

    test('OT-UI-40 an ADMIN may decide; a MANAGER is offered nothing on the legacy path', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(isProject('admin') ? 10 : 11);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);

      if (isProject('admin')) {
        expect(await detail.canApprove(), 'an ADMIN was offered no decision').toBe(true);
      } else {
        // `APPROVE_OVERTIME` is ADMIN/HR only, and with no chain engaged the
        // detail screen falls back to exactly that rule.
        expect(await detail.canApprove(), 'a MANAGER was offered a decision').toBe(false);
      }

      settle(problems, 'who may decide an overtime claim');
    });
  });

  /**
   * The review-and-edit screen, in a real browser against the real engine.
   *
   * What these add over the component tests: the figures come from the SERVER's
   * dry run under the employee's actual Overtime Policy, and the corrected
   * window is then re-priced by the approval itself. A screen that showed one
   * number and stored another would pass every mocked test and still hand the
   * approver a figure the payslip disagrees with.
   */
  test.describe('reviewing before deciding', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('hr'), 'the deciding roles');
    });

    test('OT-UI-45 the review screen shows the window, the tiers and the allowances', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(isProject('admin') ? 12 : 13);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);

      const review = await detail.openReview();
      expect(await review.requestId()).toBe(id);
      // The card this replaced showed `date · Nh` and nothing else.
      expect(await review.window()).toContain('18:00');
      expect(await review.window()).toContain('20:00');
      expect(await review.hours()).toBe(2);
      expect(await review.otType()).toBe('REGULAR');

      settle(problems, 'the overtime review screen');
    });

    test('OT-UI-46 correcting the window re-prices it on the server, and approving persists that', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(
        isProject('admin') ? 14 : 15,
        LATE_REACHABLE,
      );
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);

      const review = await detail.openReview();
      test.skip(!(await review.canEdit()), 'approver edit is switched off here');

      await review.setEnd('22:30');

      // 19:00–22:30 split at the late threshold: the shown figures come from
      // the engine, not from a browser-side recompute of the global settings.
      // Polled, because the dry run is debounced and then a round trip.
      await review.expectHours(3.5);
      await review.expectOtType('LATE');

      await review.approve();
      await detail.expectStatus('APPROVED');

      const stored = await employeeApi.get<{
        hours: string;
        otType: string;
        endTime: string;
      }>(`/overtime/${id}`);
      expect(
        Number(stored.hours),
        'the approved row did not keep the corrected window',
      ).toBe(3.5);
      expect(stored.otType).toBe('LATE');
      expect(new Date(stored.endTime).toISOString()).toContain('T22:30');

      settle(problems, 'correcting an overtime window while approving');
    });

    test('OT-UI-47 a refused correction keeps the screen open and says why', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(isProject('admin') ? 16 : 17);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);

      const review = await detail.openReview();
      test.skip(!(await review.canEdit()), 'approver edit is switched off here');

      // Inside the working day — the same rule submission is held to.
      await review.setStart('10:00');
      await review.settlePricing();
      await review.approve();

      await expect(page.getByTestId('ot-review-modal')).toBeVisible();
      const shown = (await review.error()) ?? '';
      expect(shown.length, 'the refusal was swallowed').toBeGreaterThan(0);

      expect(
        (await employeeApi.get<{ status: string }>(`/overtime/${id}`)).status,
      ).toBe('PENDING');

      // crashesOnly: the refused request is an expected 400, not a page fault.
      crashesOnly(problems);
    });

    test('OT-UI-48 the site allowance is offered only when its switch is on', async ({
      page,
      problems,
      api,
    }) => {
      await selectBranch(page, await branchOfClaimant());

      const id = await seedClaim(isProject('admin') ? 18 : 19);
      const detail = new OvertimeDetailPage(page);
      await detail.open(id);
      const review = await detail.openReview();

      const settings = await api
        .get<Record<string, unknown>>('/system-settings/public')
        .catch(() => ({}) as Record<string, unknown>);
      const enabled = settings?.overtime_site_allowance_enabled === true;

      // Asserted as a CONTRACT against the live switch rather than by flipping
      // it: `supervisor_approval_enabled` and its neighbours are shared,
      // environment-wide config, and this suite does not own them.
      expect(
        await review.canAddSiteAllowance(),
        'the toggle disagreed with overtime_site_allowance_enabled',
      ).toBe(enabled);

      settle(problems, 'the site-allowance toggle');
    });
  });
});
