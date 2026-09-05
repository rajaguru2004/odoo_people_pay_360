import {
  test,
  expect,
  settle,
  crashesOnly,
  renderOnly,
  ApiClient,
} from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  ShiftManagementPage,
  ScheduleFormModal,
  BulkScheduleModalPage,
  captureNativeDialogs,
  dismissNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * Shift Management — the screen that builds a roster.
 *
 * Unlike the overview this one WRITES, so the journeys here are create → confirm
 * → delete, plus the two ways a write can be refused: by the client before it is
 * sent, and by the server afterwards. The second is the interesting one. Both
 * modals used to read `error.response?.data?.message`, a path this app's axios
 * interceptor never fills, so a duplicate shift, a leave-day clash, a contract
 * window and an out-of-branch employee all surfaced as the same generic
 * sentence — the user was told something went wrong and never which rule they
 * had broken (T19).
 *
 * Layer discipline (plan §4.1): the RULES are asserted once each on the backend
 * (`time-schedule.e2e-spec.ts`). What this file asserts is that the server's
 * reason reaches the user — one case, not one per rule.
 *
 * ## Dates come from the screen, never from the calendar
 *
 * This spec does not choose its own dates. The shift list renders whatever
 * window FullCalendar is currently showing, and that window is NOT the month:
 * the screen opens on a WEEK, so a shift written to "the 10th" saves perfectly
 * and simply is not in view — and the failure reads as "the create did not
 * work", which is how this file's first draft failed.
 *
 * So every case reads the range out of the request the page actually made and
 * writes inside it. That is the same discipline the attendance module arrived at
 * after three of its cases located a row by a date the test computed rather than
 * the one the service used, and it makes these cases independent of whatever
 * view the calendar happens to open on.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The employee this spec rosters. Nothing else writes to them. */
const SUBJECT = 'E2E-SCHFLEX';

async function pinBranch(
  page: Parameters<typeof selectBranch>[0],
  api: { get: <T>(path: string) => Promise<T> },
  code: string,
): Promise<string> {
  const res = await api.get<
    { id: string; code: string }[] | { data: { id: string; code: string }[] }
  >('/branches');
  const rows = Array.isArray(res) ? res : (res?.data ?? []);
  const branch = rows.find((b) => b.code === code);
  if (!branch) throw new Error(`branch ${code} is missing from the baseline`);
  await selectBranch(page, branch.id);
  return branch.id;
}

/** The subject employee's id, which the form's `<select>` uses as its value. */
async function subjectId(api: {
  get: <T>(path: string) => Promise<T>;
}): Promise<string> {
  const res = await api.get<any>(`/employees?search=${SUBJECT}&limit=5`);
  const rows = Array.isArray(res) ? res : (res?.data ?? []);
  const subject = rows.find((e: any) => e.employeeCode === SUBJECT);
  if (!subject) throw new Error(`${SUBJECT} is missing from the baseline`);
  return subject.id as string;
}

/** Records the `/calendar/my-calendar` requests the shift screen makes. */
function recordCalendarCalls(
  page: Parameters<typeof selectBranch>[0],
): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.startsWith(API_URL) && url.includes('/calendar/my-calendar')) {
      urls.push(url);
    }
  });
  return urls;
}

/**
 * The window the shift list is currently showing, taken from the screen's own
 * last request rather than assumed.
 */
async function visibleRange(
  urls: string[],
  employeeId: string,
): Promise<{ start: string; end: string }> {
  await expect
    .poll(
      () => urls.filter((u) => u.includes(`employeeId=${employeeId}`)).length,
      { message: 'waiting for the shift list to query the selected employee' },
    )
    .toBeGreaterThan(0);

  const mine = urls.filter((u) => u.includes(`employeeId=${employeeId}`));
  const params = new URL(mine[mine.length - 1]).searchParams;
  return { start: params.get('startDate')!, end: params.get('endDate')! };
}

/** `offset` days after `date`, as `YYYY-MM-DD`, read as calendar parts. */
function plusDays(date: string, offset: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + offset);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/**
 * Remove every schedule for `SUBJECT` in a wide window around today.
 *
 * Wide rather than exact: the cases write inside whatever range the screen
 * happens to be showing, so teardown cannot enumerate the dates it needs to
 * clear. `SUBJECT` is seeded only into May 2026 and written by nothing else, so
 * over-reaching costs nothing, while leaving one row behind would make the next
 * case's count assertion fail for a reason that has nothing to do with it.
 */
async function clearSubjectShifts(api: ApiClient): Promise<void> {
  const id = await subjectId(api).catch(() => null);
  if (!id) return;
  const now = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const to = iso(new Date(now.getFullYear(), now.getMonth() + 2, 0));

  const res = await api.get<any>(
    `/calendar/my-calendar?startDate=${from}&endDate=${to}&employeeId=${id}`,
  );
  const events = Array.isArray(res) ? res : (res?.data ?? []);
  for (const event of events.filter((e: any) => e.type === 'work')) {
    await api.delete(`/calendar/schedules/${event.id}`).catch(() => undefined);
  }
}

test.describe('rostering, as an admin', () => {
  test.beforeEach(async ({ page, api }) => {
    test.skip(!isProject('admin'), 'the roster is written once, as admin');
    await pinBranch(page, api, 'HO');
    await clearSubjectShifts(api);
  });

  test.afterEach(async ({ api }) => {
    if (!isProject('admin')) return;
    await clearSubjectShifts(api);
  });

  test('SHF-UI-01 the employee rail lists, searches and reports an empty result', async ({
    page,
    problems,
  }) => {
    const shifts = new ShiftManagementPage(page);
    await shifts.open();

    await expect(shifts.employee(SUBJECT)).toBeVisible();

    await shifts.employeeSearch.fill('Fiona');
    await expect(shifts.employee(SUBJECT)).toBeVisible();

    await shifts.employeeSearch.fill('nobody-by-this-name');
    await expect(shifts.employeeEmpty).toBeVisible();
    settle(problems);
  });

  test('SHF-UI-02 selecting an employee queries their roster for the visible window', async ({
    page,
    api,
  }) => {
    const shifts = new ShiftManagementPage(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);

    // The screen asked for a real window, for the employee that was clicked.
    expect(range.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(range.end)).toBeGreaterThanOrEqual(
      Date.parse(range.start),
    );
    await expect(shifts.list).toBeVisible();
  });

  test('SHF-UI-03 create a shift end to end, and it appears in the list', async ({
    page,
    api,
  }) => {
    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const target = plusDays(range.start, 1);
    const before = Number((await shifts.shiftCount.textContent()) ?? '0');

    await shifts.createButton.click();
    await expect(form.form).toBeVisible();
    // By VALUE, not by label: `selectOption` takes a string label and the
    // rendered option carries the employee code alongside the name, so a regex
    // is rejected outright and an exact string would encode the display format.
    await form.employee.selectOption(id);
    await form.date.fill(target);
    await form.shiftType('FULL_DAY').click();
    await form.submit.click();

    // This employee has no active contract, so submit raises the two-stage
    // warning rather than saving. Confirming it is part of the journey — see
    // SHF-UI-04 for the case that asserts the dialog is a real gate.
    await expect(form.contractWarning).toBeVisible();
    await form.contractConfirm.click();
    await expect(form.form).toBeHidden();

    // Asserted in two steps, on purpose. The screen and the server can disagree
    // in either direction — a save that did not happen, or a save that did and a
    // list that never re-read — and one assertion on the counter cannot tell
    // those apart. This way the first failure names the layer.
    const stored = await api.get<any>(
      `/calendar/my-calendar?startDate=${target}&endDate=${target}&employeeId=${id}`,
    );
    const events = Array.isArray(stored) ? stored : (stored?.data ?? []);
    expect(
      events.filter((e: any) => e.type === 'work'),
      'the server did not store the shift',
    ).toHaveLength(1);

    await expect
      .poll(async () => Number((await shifts.shiftCount.textContent()) ?? '0'))
      .toBe(before + 1);
  });

  test('SHF-UI-04 the contract warning is a real gate: cancelling saves nothing', async ({
    page,
    api,
  }) => {
    // A confirmation that proceeds whether or not you agree is worse than none,
    // because it reads as a safeguard. The dialog exists because scheduling
    // somebody with no contract is allowed but wants a deliberate act.
    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const target = plusDays(range.start, 2);

    await shifts.createButton.click();
    await expect(form.form).toBeVisible();
    await form.employee.selectOption(id);
    await form.date.fill(target);
    await form.shiftType('FULL_DAY').click();
    await form.submit.click();

    await expect(form.contractWarning).toBeVisible();
    await form.contractCancel.click();

    // Back to the form, with nothing written — asserted against the SERVER,
    // because "the modal is still open" is not evidence that no row exists.
    await expect(form.contractWarning).toBeHidden();
    await expect(form.form).toBeVisible();

    const stored = await api.get<any>(
      `/calendar/my-calendar?startDate=${target}&endDate=${target}&employeeId=${id}`,
    );
    const events = Array.isArray(stored) ? stored : (stored?.data ?? []);
    expect(events.filter((e: any) => e.type === 'work')).toHaveLength(0);
  });

  test('SHF-UI-05 FLEXIBLE swaps the time pair for a target-hours field', async ({
    page,
  }) => {
    // The field swap is the whole shape of a flexible shift: no window, a
    // number of hours. A form that left the time inputs on screen would be
    // collecting values the server discards.
    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    await shifts.createButton.click();
    await expect(form.form).toBeVisible();

    await form.shiftType('FULL_DAY').click();
    await expect(form.start).toBeVisible();
    await expect(form.hours).toHaveCount(0);

    await form.shiftType('FLEXIBLE').click();
    await expect(form.hours).toBeVisible();
    await expect(form.start).toHaveCount(0);
  });

  test('SHF-UI-06 start and end are editable only for CUSTOM', async ({
    page,
  }) => {
    // Every fixed type pre-fills its own window; only CUSTOM lets the user move
    // it. Asserted because "disabled" is invisible to a click-through that only
    // checks the value.
    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);
    await shifts.createButton.click();
    await expect(form.form).toBeVisible();

    await form.shiftType('MORNING').click();
    await expect(form.start).toBeDisabled();

    await form.shiftType('CUSTOM').click();
    await expect(form.start).toBeEnabled();
    await expect(form.end).toBeEnabled();
  });

  test('SHF-UI-07 client validation refuses an empty date before anything is sent', async ({
    page,
  }) => {
    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);
    await shifts.createButton.click();
    await expect(form.form).toBeVisible();

    await form.date.fill('');
    await form.submit.click();

    await expect(form.fieldError('date')).toBeVisible();
    // And the form is still open, because nothing was sent.
    await expect(form.form).toBeVisible();
  });

  test('SHF-UI-08 T19: a duplicate shift shows the SERVER reason, not a generic sentence', async ({
    page,
    problems,
    api,
  }) => {
    // The case this finding exists for. Both modals read
    // `error.response?.data?.message`, which this app's axios interceptor never
    // fills — so every refusal, whatever its cause, reached the user as "An
    // error occurred while saving the work schedule".
    //
    // `renderOnly`: the 400 below is the SUBJECT of the test, so the harness
    // seeing a non-2xx on the page is the setup working, not a defect.
    renderOnly(problems);

    const shifts = new ShiftManagementPage(page);
    const form = new ScheduleFormModal(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const target = plusDays(range.start, 3);

    // Seed the clash through the API so the case is about the SECOND write.
    await api.post('/calendar/schedules', {
      employeeId: id,
      date: target,
      shiftType: 'FULL_DAY',
      startTime: `${target}T09:00:00.000Z`,
      endTime: `${target}T18:00:00.000Z`,
    });

    await shifts.createButton.click();
    await expect(form.form).toBeVisible();
    await form.employee.selectOption(id);
    await form.date.fill(target);
    await form.shiftType('FULL_DAY').click();
    await form.submit.click();

    // The contract gate first — it is a CLIENT confirmation, and the server has
    // not been asked anything yet.
    await expect(form.contractWarning).toBeVisible();
    await form.contractConfirm.click();

    await expect(form.formError).toBeVisible();
    // The server's own words. "overlaps" is the reason; the generic fallback
    // says only that something went wrong.
    await expect(form.formError).toContainText(/overlap/i);
  });

  test('SHF-UI-09 T21: delete is reachable from Shift Management and the shift goes', async ({
    page,
    api,
  }) => {
    // `deleteSchedule` used to be wired only into `/dashboard/my-calendar`, and
    // gated there on `EDIT_SCHEDULE` — so the screen that builds the roster
    // could not remove from it, and `DELETE_SCHEDULE` was a permission nothing
    // in the app consulted.
    const shifts = new ShiftManagementPage(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const target = plusDays(range.start, 1);
    await api.post('/calendar/schedules', {
      employeeId: id,
      date: target,
      shiftType: 'FULL_DAY',
      startTime: `${target}T09:00:00.000Z`,
      endTime: `${target}T18:00:00.000Z`,
    });

    await shifts.open();
    await shifts.selectEmployee(SUBJECT);
    await expect
      .poll(async () => Number((await shifts.shiftCount.textContent()) ?? '0'))
      .toBe(1);

    // The control confirms with a native dialog, which Playwright dismisses by
    // default — so without this the click is a no-op and the failure reads as a
    // broken backend.
    const asked = captureNativeDialogs(page);
    await shifts.anyDeleteButton.click();

    await expect
      .poll(async () => Number((await shifts.shiftCount.textContent()) ?? '0'))
      .toBe(0);
    expect(asked.join(' ')).toMatch(/delete/i);
  });

  test('SHF-UI-10 dismissing the delete confirmation changes nothing', async ({
    page,
    api,
  }) => {
    // The other half of the pair. A confirm that deletes whether or not you
    // agree is worse than no confirm at all, and it is invisible to a test that
    // only ever accepts.
    const shifts = new ShiftManagementPage(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const target = plusDays(range.start, 2);
    await api.post('/calendar/schedules', {
      employeeId: id,
      date: target,
      shiftType: 'FULL_DAY',
      startTime: `${target}T09:00:00.000Z`,
      endTime: `${target}T18:00:00.000Z`,
    });

    await shifts.open();
    await shifts.selectEmployee(SUBJECT);
    await expect
      .poll(async () => Number((await shifts.shiftCount.textContent()) ?? '0'))
      .toBe(1);

    dismissNativeDialogs(page);
    await shifts.anyDeleteButton.click();
    await page.waitForTimeout(500);

    await expect(shifts.shiftCount).toHaveText('1');
    const stored = await api.get<any>(
      `/calendar/my-calendar?startDate=${target}&endDate=${target}&employeeId=${id}`,
    );
    const events = Array.isArray(stored) ? stored : (stored?.data ?? []);
    expect(events.filter((e: any) => e.type === 'work')).toHaveLength(1);
  });

  test('SHF-UI-11 the bulk modal opens with its range and skip-days', async ({
    page,
  }) => {
    const shifts = new ShiftManagementPage(page);
    const bulk = new BulkScheduleModalPage(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    await shifts.bulkCreateButton.click();
    await expect(bulk.form).toBeVisible();

    // Saturday and Sunday are pre-skipped, which is the default roster shape.
    await expect(bulk.skipDay(0)).toHaveAttribute('data-skipped', 'true');
    await expect(bulk.skipDay(6)).toHaveAttribute('data-skipped', 'true');
    await expect(bulk.skipDay(3)).toHaveAttribute('data-skipped', 'false');

    // Toggling is a real toggle, not a one-way set.
    await bulk.skipDay(3).click();
    await expect(bulk.skipDay(3)).toHaveAttribute('data-skipped', 'true');
    await bulk.skipDay(3).click();
    await expect(bulk.skipDay(3)).toHaveAttribute('data-skipped', 'false');

    await bulk.cancel.click();
    await expect(bulk.form).toBeHidden();
  });

  test('SHF-UI-12 the bulk shift-type buttons select one at a time', async ({
    page,
  }) => {
    const shifts = new ShiftManagementPage(page);
    const bulk = new BulkScheduleModalPage(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);
    await shifts.bulkCreateButton.click();
    await expect(bulk.form).toBeVisible();

    await bulk.shiftType('FLEXIBLE').click();
    await expect(bulk.shiftType('FLEXIBLE')).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(bulk.shiftType('FULL_DAY')).toHaveAttribute(
      'data-selected',
      'false',
    );
    // FLEXIBLE swaps in the target-hours field here too.
    await expect(bulk.hours).toBeVisible();
  });

  test('SHF-UI-13 a bulk run reports counts that agree with the database', async ({
    page,
    api,
  }) => {
    // Bulk is deliberately NOT transactional: a month's roster where somebody is
    // on leave for two days should produce the other twenty, and the response
    // reports the split. This is the screen half of that decision — the counts
    // shown have to be the ones the server actually produced.
    const shifts = new ShiftManagementPage(page);
    const bulk = new BulkScheduleModalPage(page);
    const calls = recordCalendarCalls(page);
    await shifts.open();
    await shifts.selectEmployee(SUBJECT);

    const id = await subjectId(api);
    const range = await visibleRange(calls, id);
    const lastDay = plusDays(range.start, 2);

    await shifts.bulkCreateButton.click();
    await expect(bulk.form).toBeVisible();
    // `check` rather than `click`: the control is a real checkbox and the modal
    // may already have it selected, in which case a click DESELECTS it and the
    // run covers nobody — which surfaces as "no result panel" rather than as
    // anything about selection.
    await bulk.employee(SUBJECT).check();
    await bulk.startDate.fill(range.start);
    await bulk.endDate.fill(lastDay);
    // Nothing skipped, so the run covers all three days whichever weekdays they
    // happen to be — the spec must not depend on when it runs.
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      const control = bulk.skipDay(day);
      if ((await control.getAttribute('data-skipped')) === 'true') {
        await control.click();
      }
    }
    await bulk.submit.click();

    // The bulk modal has its own contract gate, distinct from the single form's.
    // Without confirming it the click produces no request at all — no error, no
    // result panel, nothing — which is the least debuggable failure on this
    // screen and the reason the page object documents it.
    await expect(bulk.contractWarning).toBeVisible();
    await bulk.contractConfirm.click();

    await expect(bulk.result).toBeVisible();
    const created = Number((await bulk.resultSuccess.textContent()) ?? '0');
    const failed = Number((await bulk.resultFailed.textContent()) ?? '0');
    expect(created + failed).toBe(3);

    const stored = await api.get<any>(
      `/calendar/my-calendar?startDate=${range.start}&endDate=${lastDay}&employeeId=${id}`,
    );
    const events = Array.isArray(stored) ? stored : (stored?.data ?? []);
    expect(events.filter((e: any) => e.type === 'work')).toHaveLength(created);
  });
});

test.describe('who may reach Shift Management', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(
      !isProject('manager') && !isProject('employee'),
      'roles that must not reach the roster',
    );
    });

    test('SHF-UI-14 a manager and an employee are refused by the screen', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);
      const shifts = new ShiftManagementPage(page);
      await shifts.open();

      await expect(page).toHaveURL(/\/403|\/dashboard$/);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(
      !isProject('manager') && !isProject('employee'),
      'roles that must not write the roster',
    );
    });

    test('SHF-UI-15 and refused by the API as well, not just hidden', async () => {
      // The screen hiding a button is presentation; the server refusing the write
      // is the control. A phase that only asserted the first would pass against an
      // API anyone could call directly.
      const role = test.info().project.name as 'manager' | 'employee';
      const client = await ApiClient.as(role);
      try {
        const outcome = await client
          .post('/calendar/schedules', {
            employeeId: '00000000-0000-4000-8000-000000000000',
            date: '2026-05-20',
            shiftType: 'FULL_DAY',
            startTime: '2026-05-20T09:00:00.000Z',
            endTime: '2026-05-20T18:00:00.000Z',
          })
          .then(() => 'allowed')
          .catch((e: Error) => e.message);
        expect(String(outcome)).toContain('403');
      } finally {
        await client.dispose();
      }
    });
  });
});
