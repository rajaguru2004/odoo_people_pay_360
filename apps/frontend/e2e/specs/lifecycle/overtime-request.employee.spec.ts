import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { OvertimeRequestPage, OvertimeListPage, ToastArea, selectBranch } from '../../pages';
import { otMonth, otMonthDay } from '../../windows';

/**
 * Registering overtime, from the claimant's side.
 *
 * `overtime.spec.ts` owns the zero-length regression and the approve/reject
 * hand-off. This file owns the half nothing has ever driven: the LIVE PREVIEW,
 * the caps, and how each server refusal reaches the person filing.
 *
 * ── Why the preview matters more than it looks ──────────────────────────────
 *
 * `computeOvertimePreview` is the same engine the backend uses, and what it
 * shows is what the employee is agreeing to be paid. If the screen and the
 * server ever disagree about the payable total, the claimant finds out on their
 * payslip. `utils/overtimeCalc.test.ts` owns the arithmetic; these cases own the
 * question of whether the screen SURFACES it.
 *
 * ── Dates and the cap budget ────────────────────────────────────────────────
 *
 * Months OT-A and OT-B (see the budget table in `e2e/windows.ts`). OT-B is a
 * BURN month: this file fills it to just under the monthly cap so one more
 * claim proves the refusal, and nothing else may file there.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const marker = `pw-otreq-${Date.now().toString(36)}`;
const reason = (extra = '') => `Automated overtime ${marker} — release window ${extra}`.trim();

/** The shared `api` fixture is ADMIN; anything scoped to "me" needs this one. */
let selfApi: ApiClient;

const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

test.beforeAll(async () => {
  if (!isProject('employee')) return;
  selfApi = await ApiClient.as('employee');
});

test.afterAll(async () => {
  await selfApi?.dispose();
});

test.describe('the form', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  test('OT-UI-01 the form renders for a filing role and refuses the past', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    const today = new Date().toISOString().slice(0, 10);
    expect(await page.getByTestId('overtime-date').getAttribute('min')).toBe(today);
    settle(problems, 'the overtime form');
  });

  test('OT-UI-02 an end equal to the start is refused, and nothing is created', async ({
    page,
    problems,
  }) => {
    const before = (await selfApi.get<unknown[]>('/overtime/my-requests')).length;

    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: otMonthDay('L1', 0),
      start: '18:00',
      end: '18:00',
      reason: reason('(zero length)'),
    });
    await form.submit();

    // The standing regression, restated on a stable selector rather than the
    // `p.text-status-error` class the screen happens to use.
    expect(await form.stillOnForm()).toBe(true);
    expect(await form.fieldError('end')).toBeTruthy();
    expect((await selfApi.get<unknown[]>('/overtime/my-requests')).length).toBe(before);

    settle(problems, 'the zero-length refusal');
  });

  test('OT-UI-04 a reason under ten characters is refused while the rule is on', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: otMonthDay('L1', 1),
      start: '18:00',
      end: '20:00',
      reason: 'short',
    });
    await form.submit();
    expect(await form.stillOnForm()).toBe(true);
    expect(await form.fieldError('reason')).toBeTruthy();
    settle(problems, 'the reason-length rule');
  });
});

test.describe('the preview — the screen computes the money', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  test('OT-UI-10 the preview stays hidden until date, start and end are all set', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    expect(await form.preview()).toBeNull();

    await form.fill({
      date: otMonthDay('L1', 2),
      start: '18:00',
      end: '20:00',
      reason: reason(),
    });
    await expect.poll(async () => (await form.preview())?.totalHours ?? 0).toBe(2);

    settle(problems, 'the preview appearing');
  });

  test('OT-UI-05 the payable hours and tier split agree with the entered window', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    // 21:00 → 23:00 straddles the 22:00 late threshold, so the split is real.
    await form.fill({
      date: otMonthDay('L1', 3),
      start: '21:00',
      end: '23:00',
      reason: reason(),
    });

    await expect.poll(async () => (await form.preview())?.totalHours ?? 0).toBe(2);
    const preview = (await form.preview())!;
    const tiers =
      (await form.tierHours('regular')) +
      (await form.tierHours('late')) +
      (await form.tierHours('double'));
    expect(tiers).toBeCloseTo(preview.totalHours, 1);
    expect(preview.otType.length).toBeGreaterThan(0);

    settle(problems, 'the tier split preview');
  });

  test('OT-UI-07 a weekend date is classified differently from a weekday', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();

    await form.fill({
      date: otMonthDay('L1', 4),
      start: '18:00',
      end: '20:00',
      reason: reason(),
    });
    await expect.poll(() => form.dayClass()).toBe('WEEKDAY');

    // The first Sunday of the same month.
    const { year, month } = otMonth('L1');
    let sunday = '';
    for (let d = 1; d <= 31; d++) {
      const day = new Date(Date.UTC(year, month - 1, d));
      if (day.getUTCMonth() !== month - 1) break;
      if (day.getUTCDay() === 0) {
        sunday = day.toISOString().slice(0, 10);
        break;
      }
    }
    await form.fill({ date: sunday, start: '18:00', end: '20:00' });
    await expect.poll(() => form.dayClass()).toBe('SUNDAY');

    settle(problems, 'the day classification');
  });

  test('OT-UI-09 the food allowance appears only once the window crosses its threshold', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();

    await form.fill({
      date: otMonthDay('L1', 5),
      start: '18:00',
      end: '20:00',
      reason: reason(),
    });
    await expect.poll(async () => (await form.preview())?.totalHours ?? 0).toBe(2);
    const early = (await form.preview())!;

    // The default threshold is 22:00.
    await form.fill({ start: '21:00', end: '23:30' });
    await expect.poll(async () => (await form.preview())?.totalHours ?? 0).toBeCloseTo(2.5, 1);
    const late = (await form.preview())!;

    expect(late.foodAllowance).toBeGreaterThanOrEqual(early.foodAllowance);
    settle(problems, 'the food allowance threshold');
  });
});

test.describe('filing, and the rules the server owns', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  let filedId = '';

  test('OT-UI-11 a valid claim redirects to my-overtime and lands PENDING', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    const date = otMonthDay('L1', 6);

    await form.open();
    await form.fill({ date, start: '18:00', end: '20:00', reason: reason('(valid)') });
    await form.submit();
    await page.waitForURL('**/my-overtime', { timeout: 20_000 });

    // The list fetches after the redirect, so the first row appears a tick
    // later — reading it straight away is a race the retry then turns into a
    // duplicate-date 400.
    const list = new OvertimeListPage(page);
    await expect.poll(() => list.rowCount(), { timeout: 20_000 }).toBeGreaterThan(0);
    const id = await list.firstRowId();
    expect(id, 'the claim did not reach my-overtime').toBeTruthy();
    filedId = id!;
    expect(await list.rowStatus(filedId)).toBe('PENDING');

    settle(problems, 'filing an overtime claim');
  });

  test('OT-UI-16 the filed claim shows its hours, type and food allowance', async ({
    page,
    problems,
  }) => {
    test.skip(!filedId, 'needs the claim filed by OT-UI-11');

    const list = new OvertimeListPage(page);
    await list.openMine();

    const record = await selfApi.get<{
      hours: string | number;
      otType: string;
      foodAllowance: string | number;
    }>(`/overtime/${filedId}`);

    // The row must agree with the record, not merely be present.
    expect(await list.rowHours(filedId)).toBeCloseTo(Number(record.hours), 1);
    expect(await list.rowOtType(filedId)).toBe(record.otType);
    expect(await list.rowFoodAllowance(filedId)).toBeCloseTo(
      Number(record.foodAllowance ?? 0),
      1,
    );

    settle(problems, 'the my-overtime row');
  });

  test('OT-UI-12 a second claim on the same date is refused, and the user is told', async ({
    page,
    problems,
  }) => {
    test.skip(!filedId, 'needs the claim filed by OT-UI-11');

    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: otMonthDay('L1', 6), // the very same date
      start: '20:00',
      end: '22:00',
      reason: reason('(dup)'),
    });
    await form.submit();

    const toast = new ToastArea(page);
    expect(await toast.waitFor('error')).toMatch(/already exists|date/i);
    expect(await form.stillOnForm()).toBe(true);

    crashesOnly(problems);
    settle(problems, 'the one-per-date refusal');
  });

  test('OT-UI-13 a claim inside regular work hours is refused', async ({ page, problems }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    await form.fill({
      date: otMonthDay('L1', 7),
      start: '10:00',
      end: '12:00',
      reason: reason('(inside hours)'),
    });
    await form.submit();

    const toast = new ToastArea(page);
    expect(await toast.waitFor('error')).toMatch(/outside|work hours/i);

    crashesOnly(problems);
    settle(problems, 'the outside-work-hours rule');
  });

  test('OT-UI-14 a claim over the daily cap is refused, with the cap in the message', async ({
    page,
    problems,
  }) => {
    const form = new OvertimeRequestPage(page);
    await form.open();
    // The default daily cap is 4h; 18:00 → 23:30 is 5.5h.
    await form.fill({
      date: otMonthDay('L1', 8),
      start: '18:00',
      end: '23:30',
      reason: reason('(over cap)'),
    });
    await form.submit();

    const toast = new ToastArea(page);
    expect(await toast.waitFor('error')).toMatch(/daily|limit/i);

    crashesOnly(problems);
    settle(problems, 'the daily cap refusal');
  });

  /**
   * OT-B is a burn month: filled here to just under the monthly cap so one more
   * claim proves the refusal. Nothing else may file into it — see the budget
   * table in `e2e/windows.ts`.
   */
  test('OT-UI-15 a claim that would breach the monthly cap is refused', async ({
    page,
    problems,
  }) => {
    // Seven 4-hour claims = 28h, seeded over the API so the browser only has to
    // drive the ONE claim that crosses the line.
    let seeded = 0;
    for (let i = 0; i < 7; i++) {
      const date = otMonthDay('L2', i);
      try {
        await selfApi.post('/overtime', {
          date,
          startTime: at(date, '18:00'),
          endTime: at(date, '22:00'),
          hours: 4,
          reason: reason('(burn)'),
        });
        seeded += 4;
      } catch {
        break; // already at the cap from an earlier run of this file
      }
    }
    test.skip(seeded === 0, 'the burn month is already full — reset the database');

    const form = new OvertimeRequestPage(page);
    const date = otMonthDay('L2', 8);
    await form.open();
    await form.fill({ date, start: '18:00', end: '22:00', reason: reason('(over month)') });
    await form.submit();

    const toast = new ToastArea(page);
    expect(await toast.waitFor('error')).toMatch(/monthly|limit|yearly/i);

    crashesOnly(problems);
    settle(problems, 'the monthly cap refusal');
  });
});

test.describe('my overtime', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the personal screen');
  });

  test('OT-UI-17 the four pills filter the table and mark themselves active', async ({
    page,
    problems,
  }) => {
    const list = new OvertimeListPage(page);
    await list.openMine();

    const all = await list.rowCount();
    test.skip(all === 0, 'needs at least one claim');

    await list.filter('PENDING', 'my-ot');
    expect(await list.activeFilter('my-ot')).toBe('PENDING');
    for (const id of await list.rowIds()) {
      expect(await list.rowStatus(id)).toBe('PENDING');
    }

    await list.filter('all', 'my-ot');
    expect(await list.rowCount()).toBe(all);

    settle(problems, 'the my-overtime filters');
  });

  test('OT-UI-18 the stat tiles agree with the rows on screen', async ({ page, problems }) => {
    const list = new OvertimeListPage(page);
    await list.openMine();
    await list.filter('all', 'my-ot');

    const ids = await list.rowIds();
    test.skip(ids.length === 0, 'needs at least one claim');
    const statuses = await Promise.all(ids.map((id) => list.rowStatus(id)));

    expect(await list.stat('total', 'my-ot')).toBe(ids.length);
    expect(await list.stat('pending', 'my-ot')).toBe(
      statuses.filter((s) => s === 'PENDING').length,
    );

    settle(problems, 'the my-overtime stat tiles');
  });

  test('OT-UI-19 an empty filter result renders the FILTERED empty message', async ({
    page,
    problems,
  }) => {
    const list = new OvertimeListPage(page);
    await list.openMine();
    await list.filter('REJECTED', 'my-ot');
    if ((await list.rowCount()) === 0) {
      expect(await list.isEmpty('my-ot')).toBe(true);
    }
    settle(problems, 'the filtered empty state');
  });
});

test.describe('the requester’s own claim', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the owning role');
  });

  test('OT-UI-20 the owner cancels a pending claim and the record follows', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    const date = otMonthDay('L1', 9);
    const created = await selfApi.post<{ id: string }>('/overtime', {
      date,
      startTime: at(date, '18:00'),
      endTime: at(date, '20:00'),
      hours: 2,
      reason: reason('(to cancel)'),
    });

    const { OvertimeDetailPage } = await import('../../pages');
    const detail = new OvertimeDetailPage(page);
    await detail.open(created.id);
    await detail.expectStatus('PENDING');
    expect(await detail.canCancel(), 'the owner was offered no cancel control').toBe(true);
    await detail.cancel();

    await expect
      .poll(
        async () => (await selfApi.get<{ status: string }>(`/overtime/${created.id}`)).status,
        { timeout: 15_000 },
      )
      .toBe('CANCELLED');

    settle(problems, 'cancelling an overtime claim');
  });

  test('OT-UI-21 an employee is offered no approval control on their own claim', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    const mine = await selfApi.get<Array<{ id: string; status: string }>>(
      '/overtime/my-requests',
    );
    const pending = (Array.isArray(mine) ? mine : []).find((r) => r.status === 'PENDING');
    test.skip(!pending, 'needs a pending claim');

    const { OvertimeDetailPage } = await import('../../pages');
    const detail = new OvertimeDetailPage(page);
    await detail.open(pending!.id);
    await detail.expectStatus('PENDING');
    expect(await detail.canApprove(), 'the claimant was offered approval').toBe(false);

    settle(problems, 'no self-approval');
  });
});
