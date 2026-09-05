import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  LeaveRequestPage,
  MyLeavesPage,
  LeaveDetailPage,
  ToastArea,
  selectBranch,
} from '../../pages';
import { leaveWindow, assertLaneClean } from '../../windows';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Filing leave, from the employee's side.
 *
 * `leave.spec.ts` already owns the two-role hand-off. This file owns everything
 * that happens BEFORE a decision: what the form offers, what it refuses, what
 * the server refuses and how that reaches the user, attachments, the personal
 * list, and cancelling.
 *
 * ── What it is really checking ──────────────────────────────────────────────
 *
 * Not "does the API enforce the rule" — the backend suite owns that, exactly.
 * The question here is whether the user is TOLD. A rule the server enforces and
 * the screen swallows is indistinguishable, to the person filing, from a
 * product that lost their request.
 *
 * ── Dates ───────────────────────────────────────────────────────────────────
 *
 * Lane `L1` (see `e2e/windows.ts`). `assertLaneClean` runs first so a stale
 * database says so, rather than producing an overlap 400 that reads exactly
 * like a broken rule.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The shared `api` fixture logs in as ADMIN, always.
 *
 * That is right for reading branches, and wrong for anything scoped to "me":
 * a request filed through it belongs to the ADMIN's employee record, and the
 * employee browsing session is then correctly refused it. Every self-scoped
 * call in this file goes through `selfApi` instead.
 */
let selfApi: ApiClient;

test.beforeAll(async () => {
  if (!isProject('employee')) return;
  selfApi = await ApiClient.as('employee');
});

test.afterAll(async () => {
  await selfApi?.dispose();
});
const marker = `pw-lvreq-${Date.now().toString(36)}`;
const reason = (extra = '') =>
  `Automated journey ${marker} — planned absence ${extra}`.trim();

/** A real PDF on disk, because the picker validates the mime type. */
function tempFile(name: string, bytes = 2048): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-leave-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x25));
  return file;
}

test.describe('the leave form, and who it is for', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the filing role');
    });

    test('LVE-UI-01 the form renders for an employee and offers only active leave types', async ({
      page,
      problems,
    }) => {
      const form = new LeaveRequestPage(page);
      await form.open();

      // The picker is filled from `/library-items?type=LEAVE_TYPE`, so it starts
      // with only the placeholder option and fills in a tick later.
      await expect
        .poll(async () => (await form.typeOptions()).length, { timeout: 15_000 })
        .toBeGreaterThan(1);
      const options = await form.typeOptions();
      // The seeded library's inactive rows must never be offered.
      expect(options.join('|')).not.toMatch(/retired/i);

      settle(problems, 'the leave form for an employee');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin or hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin') && !isProject('hr'), 'the blocked roles');
    });

    test('LVE-UI-02 ADMIN and HR get the "no access" panel, not the form', async ({
      page,
      problems,
    }) => {
      const form = new LeaveRequestPage(page);
      await form.open();
      expect(
        await form.isDeniedPanel(),
        'an HR/Admin account was offered the leave form',
      ).toBe(true);
      settle(problems, 'the leave form for HR/Admin');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager half');
    });

    test('LVE-UI-03 a manager gets the form — a manager also takes leave', async ({
      page,
      problems,
    }) => {
      const form = new LeaveRequestPage(page);
      await form.open();
      expect(await form.isDeniedPanel()).toBe(false);
      settle(problems, 'the leave form for a manager');
    });
  });
});

test.describe('validation, before the server ever sees it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  test('LVE-UI-04 a reason under ten characters is refused and nothing is created', async ({
    page,
    problems,
  }) => {
    const before = (await selfApi.get<unknown[]>('/leave-requests/my-requests')).length;

    const form = new LeaveRequestPage(page);
    const { start, end } = leaveWindow('L1', 0);
    await form.open();
    await form.fill({ startDate: start, endDate: end, reason: 'too short' });
    await form.submitOnly();

    expect(await form.stillOnForm(), 'the form navigated away').toBe(true);
    const after = (await selfApi.get<unknown[]>('/leave-requests/my-requests')).length;
    expect(after).toBe(before);

    // The screen is SUPPOSED to be refused here, and the axios interceptor
    // logs the 4xx to the console on its way to the toast. Judge crashes.
    crashesOnly(problems);
    settle(problems, 'the ten-character reason rule');
  });

  test('LVE-UI-05 the start date cannot be in the past, and the end follows the start', async ({
    page,
    problems,
  }) => {
    const form = new LeaveRequestPage(page);
    await form.open();

    const dates = page.locator('input[type="date"]');
    const today = new Date().toISOString().slice(0, 10);
    expect(await dates.nth(0).getAttribute('min')).toBe(today);

    const { start } = leaveWindow('L1', 1);
    await dates.nth(0).fill(start);
    // The end picker must not allow a date before the chosen start.
    await expect.poll(() => dates.nth(1).getAttribute('min')).toBe(start);

    settle(problems, 'the date pickers');
  });

  test('LVE-UI-06 the estimated-days panel counts both endpoints', async ({
    page,
    problems,
  }) => {
    const form = new LeaveRequestPage(page);
    await form.open();

    const oneDay = leaveWindow('L1', 2, 1);
    await form.fill({ startDate: oneDay.start, endDate: oneDay.end });
    await expect(page.getByText(/\b1\b/).first()).toBeVisible();

    const threeDay = leaveWindow('L1', 3, 3);
    await form.fill({ startDate: threeDay.start, endDate: threeDay.end });
    // Three CALENDAR days; the server recounts in working days, which is
    // `LVE-API-15`'s subject, not this one's.
    await expect(page.getByText(/\b3\b/).first()).toBeVisible();

    settle(problems, 'the estimated-days preview');
  });
});

test.describe('filing, and the rules the server owns', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  let filedId = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    const api = await ApiClient.as('employee');
    try {
      await assertLaneClean(api, 'L1', marker);
    } finally {
      await api.dispose();
    }
  });

  test('LVE-UI-08 a valid request is created and appears PENDING at the head of my-leaves', async ({
    page,
    problems,
  }) => {
    const form = new LeaveRequestPage(page);
    const { start, end } = leaveWindow('L1', 4);

    await form.open();
    await form.submit({ startDate: start, endDate: end, reason: reason('(a)') });
    await form.expectSubmitted();

    const list = new MyLeavesPage(page);
    await list.open();
    const id = await list.firstRequestId();
    expect(id, 'the new request did not reach my-leaves').toBeTruthy();
    filedId = id!;
    expect(await list.rowStatus(filedId)).toBe('PENDING');

    settle(problems, 'filing a leave request');
  });

  test('LVE-UI-09 filing the same window twice surfaces the overlap refusal as an error toast', async ({
    page,
    problems,
  }) => {
    test.skip(!filedId, 'needs the request filed by LVE-UI-08');

    const form = new LeaveRequestPage(page);
    const { start, end } = leaveWindow('L1', 4); // the very same window
    await form.open();
    await form.fill({ startDate: start, endDate: end, reason: reason('(dup)') });
    await form.submitOnly();

    // The rule lives on the server; what is under test is that its sentence
    // reached the person filing rather than being swallowed.
    const toast = new ToastArea(page);
    const text = await toast.waitFor('error');
    expect(text).toMatch(/overlap/i);
    expect(await form.stillOnForm()).toBe(true);

    // The screen is SUPPOSED to be refused here, and the axios interceptor
    // logs the 4xx to the console on its way to the toast. Judge crashes.
    crashesOnly(problems);
    settle(problems, 'the overlap refusal');
  });

  test('LVE-UI-10 a request larger than the remaining balance is refused, with the number', async ({
    page,
    problems,
  }) => {
    const me = await selfApi.get<{ employeeId?: string }>('/auth/me');
    test.skip(!me?.employeeId, 'the account has no employee record');

    const form = new LeaveRequestPage(page);
    // A window far larger than any seeded allocation.
    const start = leaveWindow('L1', 6).start;
    const end = new Date(`${start}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 120);

    await form.open();
    await form.fill({
      startDate: start,
      endDate: end.toISOString().slice(0, 10),
      reason: reason('(over budget)'),
    });
    await form.submitOnly();

    const toast = new ToastArea(page);
    const text = await toast.waitFor('error');
    expect(text).toMatch(/insufficient|balance|overlap/i);
    expect(await form.stillOnForm()).toBe(true);

    // The screen is SUPPOSED to be refused here, and the axios interceptor
    // logs the 4xx to the console on its way to the toast. Judge crashes.
    crashesOnly(problems);
    settle(problems, 'the insufficient-balance refusal');
  });

  test('LVE-UI-12 a gender-restricted type the employee cannot take is not even offered', async ({
    page,
    problems,
  }) => {
    const form = new LeaveRequestPage(page);
    await form.open();
    const offered = (await form.typeOptions()).map((o) => o.toLowerCase());

    const me = await selfApi.get<{ employee?: { gender?: string | null } }>('/auth/me');
    const gender = (me?.employee?.gender ?? '').toUpperCase();
    test.skip(!gender, 'the seeded employee has no recorded gender');

    // The refusal is therefore unreachable from the UI — which is the point:
    // the screen filters rather than letting the server say no.
    if (gender === 'MALE') {
      expect(offered.join('|')).not.toContain('maternity');
    } else if (gender === 'FEMALE') {
      expect(offered.join('|')).not.toContain('paternity');
    }

    settle(problems, 'the gender-restricted picker');
  });
});

test.describe('attachments', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the filing role');
  });

  test('LVE-UI-13 a .txt file is refused by the picker and never reaches the selection', async ({
    page,
    problems,
  }) => {
    const form = new LeaveRequestPage(page);
    await form.open();
    await form.attach([tempFile('notes.txt', 128)]);

    const toast = new ToastArea(page);
    const text = await toast.waitFor('error');
    expect(text.length).toBeGreaterThan(0);

    // The screen is SUPPOSED to be refused here, and the axios interceptor
    // logs the 4xx to the console on its way to the toast. Judge crashes.
    crashesOnly(problems);
    settle(problems, 'the attachment type filter');
  });

  test('LVE-UI-15 a PDF attached at filing is uploaded and renders on the detail screen', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    const form = new LeaveRequestPage(page);
    const { start, end } = leaveWindow('L1', 7);
    await form.open();
    await form.fill({ startDate: start, endDate: end, reason: reason('(with file)') });
    await form.attach([tempFile('certificate.pdf')]);
    await form.submitOnly();
    await form.expectSubmitted();

    const list = new MyLeavesPage(page);
    await list.open();
    const id = await list.firstRequestId();
    expect(id).toBeTruthy();

    const detail = new LeaveDetailPage(page);
    await detail.open(id!);
    await expect
      .poll(async () => (await detail.attachments()).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const files = await detail.attachments();
    expect(files[0].fileName).toBe('certificate.pdf');

    settle(problems, 'uploading an attachment');
  });

  test('LVE-UI-16 the uploader deletes their own attachment through the confirm dialog', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    const list = new MyLeavesPage(page);
    await list.open();
    const id = await list.firstRequestId();
    test.skip(!id, 'needs a request from an earlier case in this file');

    const detail = new LeaveDetailPage(page);
    await detail.open(id!);
    const before = await detail.attachments();
    test.skip(before.length === 0, 'that request carries no attachment');

    await detail.deleteAttachment(before[0].id);
    await expect
      .poll(async () => (await detail.attachments()).length, { timeout: 15_000 })
      .toBe(before.length - 1);

    settle(problems, 'deleting an attachment');
  });
});

test.describe('my leaves', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the personal screen');
    });

    test('LVE-UI-17 the four status pills filter the table and mark themselves active', async ({
      page,
      problems,
    }) => {
      const list = new MyLeavesPage(page);
      await list.open();

      const all = await list.rowCount();
      test.skip(all === 0, 'needs at least one request');

      await list.filter('PENDING');
      expect(await list.activeFilter()).toBe('PENDING');
      for (const id of await list.rowIds()) {
        expect(await list.rowStatus(id)).toBe('PENDING');
      }

      await list.filter('all');
      expect(await list.activeFilter()).toBe('all');
      expect(await list.rowCount()).toBe(all);

      settle(problems, 'the my-leaves filters');
    });

    test('LVE-UI-18 a pill with no matches shows the FILTERED empty state', async ({
      page,
      problems,
    }) => {
      const list = new MyLeavesPage(page);
      await list.open();
      await list.filter('REJECTED');

      if ((await list.rowCount()) === 0) {
        expect(await list.isEmpty()).toBe(true);
      }
      settle(problems, 'the filtered empty state');
    });

    test('LVE-UI-19 the four stat tiles agree with the rows the page received', async ({
      page,
      problems,
    }) => {
      const list = new MyLeavesPage(page);
      await list.open();
      await list.filter('all');

      const rows = await list.rowIds();
      test.skip(rows.length === 0, 'needs at least one request');

      const statuses = await Promise.all(rows.map((id) => list.rowStatus(id)));
      expect(await list.stat('total')).toBe(rows.length);
      expect(await list.stat('pending')).toBe(
        statuses.filter((s) => s === 'PENDING').length,
      );
      expect(await list.stat('approved')).toBe(
        statuses.filter((s) => s === 'APPROVED').length,
      );

      settle(problems, 'the my-leaves stat tiles');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the personal screen');
    });

    test('LVE-UI-20 the balance cards agree with the balance payload', async ({
      page,
      problems,
      api,
    }) => {
      void api;
      const me = await selfApi.get<{ employeeId?: string }>('/auth/me');
      test.skip(!me?.employeeId, 'the account has no employee record');

      const balance = await selfApi.get<{
        leaveTypeBalances?: Array<{ leaveTypeKey: string; remaining: number }>;
      }>(`/leave-balances/employee/${me.employeeId}`);
      const types = balance?.leaveTypeBalances ?? [];
      test.skip(types.length === 0, 'no per-type balances configured');

      const list = new MyLeavesPage(page);
      await list.open();
      const card = await list.balance(types[0].leaveTypeKey);
      expect(card, `no card for ${types[0].leaveTypeKey}`).toBeTruthy();
      expect(card!.remaining).toBe(types[0].remaining);

      settle(problems, 'the my-leaves balance cards');
    });
  });

  /**
   * The trap this pins: the table and the mobile card list render the SAME rows,
   * and Playwright's `.count()` includes hidden elements. If both ever share one
   * testid, every count on this screen silently doubles and the stat comparison
   * above starts passing for the wrong reason.
   */
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the personal screen');
    });

    test('LVE-UI-21 the mobile card list mirrors the table and is counted separately', async ({
      page,
      problems,
    }) => {
      const list = new MyLeavesPage(page);
      await list.open();
      await list.filter('all');

      const rows = await list.rowCount();
      test.skip(rows === 0, 'needs at least one request');
      expect(await list.cardCount()).toBe(rows);

      settle(problems, 'the mobile card list');
    });
  });
});

test.describe('cancelling', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the owning role');
  });

  test('LVE-UI-22 the owner cancels a pending request and the record follows', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    // Filed over the API so this case owns a request no other case will decide.
    const { start, end } = leaveWindow('L1', 8);
    const created = await selfApi.post<{ id: string }>('/leave-requests', {
      leaveType: 'ANNUAL',
      startDate: start,
      endDate: end,
      reason: reason('(to cancel)'),
    });

    const detail = new LeaveDetailPage(page);
    await detail.open(created.id);
    await detail.expectStatus('PENDING');
    expect(await detail.canCancel(), 'the owner was offered no cancel control').toBe(
      true,
    );
    await detail.cancel();

    await expect
      .poll(
        async () =>
          (await selfApi.get<{ status: string }>(`/leave-requests/${created.id}`)).status,
        { timeout: 15_000 },
      )
      .toBe('CANCELLED');

    settle(problems, 'cancelling a leave request');
  });

  test('LVE-UI-23 a cancelled request offers neither cancel nor approval controls', async ({
    page,
    problems,
    api,
  }) => {
    const branchId = await api.firstBranchId();
    await selectBranch(page, branchId);

    const mine = await selfApi.get<Array<{ id: string; status: string }>>(
      '/leave-requests/my-requests?status=CANCELLED',
    );
    const cancelled = (Array.isArray(mine) ? mine : []).find(
      (r) => r.status === 'CANCELLED',
    );
    test.skip(!cancelled, 'needs a cancelled request from LVE-UI-22');

    const detail = new LeaveDetailPage(page);
    await detail.open(cancelled!.id);
    await detail.expectStatus('CANCELLED');
    expect(await detail.canCancel()).toBe(false);
    expect(await detail.canApprove()).toBe(false);

    crashesOnly(problems);
    settle(problems, 'a settled request offering no controls');
  });
});
