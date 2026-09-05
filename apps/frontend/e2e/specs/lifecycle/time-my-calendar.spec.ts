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
  MyCalendarPage,
  ScheduleFormModal,
  captureNativeDialogs,
  dismissNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * My Calendar — the ESS view of one's own roster.
 *
 * The only screen in the module that is `guarded: false`, and correctly so:
 * everybody owns a calendar, so the route admits all four roles and the WRITE
 * controls are permission-gated instead. That split is the thing worth testing.
 * A screen that hides the create button but leaves the route open is fine; a
 * screen that shows an employee a delete button they cannot use, or hides one
 * from an admin who can, is not — and neither is visible from the route matrix,
 * which only asks whether the page rendered.
 *
 * It is also the screen that used to own the ONLY delete path in the whole
 * module, gated on `EDIT_SCHEDULE` rather than `DELETE_SCHEDULE` (T21). Both
 * halves of that are asserted here: the permission it now reads, and the fact
 * that Shift Management has its own control (in `time-schedule-shifts.spec.ts`).
 *
 * Dates come from the screen. The event list only renders once a day is
 * selected, and the calendar opens on the current month — so every case picks
 * TODAY, clicks its cell, and works there. Nothing here depends on the seeded
 * May roster, which belongs to other people.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Today, as the calendar's own `data-date` attribute spells it. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Click a day cell in FullCalendar.
 *
 * `.fc-daygrid-day[data-date]` is structural rather than a `data-testid`, and
 * deliberately: the grid is rendered by FullCalendar, not by this app, so there
 * is nothing of ours to tag. The attribute is part of FullCalendar's public DOM
 * contract and is the same in every view that has day cells.
 */
async function selectDay(
  page: Parameters<typeof captureNativeDialogs>[0],
  date: string,
): Promise<void> {
  // The day NUMBER, not the cell.
  //
  // A day cell contains its events, so clicking its middle lands on a shift and
  // fires `eventClick` — which opens the EDIT modal, a different and perfectly
  // correct behaviour that simply is not the one under test. The number sits in
  // `.fc-daygrid-day-top`, above the event stack, so a click there is always a
  // day click.
  //
  // There is no modal-dismissal step any more. It used to need one: for a role
  // holding `CREATE_SCHEDULE`, FullCalendar consumed the click as a range select
  // and the page turned that straight into an open create modal, which then
  // intercepted every later click. That was T26, and it is fixed — a day click
  // now selects the day and nothing else, for every role. MYC-UI-08 is the case
  // that would catch it coming back.
  await page
    .locator(`.fc-daygrid-day[data-date="${date}"] .fc-daygrid-day-number`)
    .first()
    .click();
}

/**
 * Point the browser at Head Office.
 *
 * The write cases need it and the read cases do not, which is exactly how this
 * trap hides. `BranchPicker` writes `options[0]` on mount when the restored
 * session has no selection — and that is E2E-BR2, not Head Office — so the
 * employee DIRECTORY the schedule modal fetches comes back scoped to the wrong
 * branch. The screen then renders a select that does not contain the person
 * whose calendar is on screen, and the failure reads as "the option does not
 * exist" rather than "the view is pointed somewhere else".
 */
async function pinBranch(
  page: Parameters<typeof selectBranch>[0],
  api: { get: <T>(path: string) => Promise<T> },
  code: string,
): Promise<void> {
  const res = await api.get<
    { id: string; code: string }[] | { data: { id: string; code: string }[] }
  >('/branches');
  const rows = Array.isArray(res) ? res : (res?.data ?? []);
  const branch = rows.find((b) => b.code === code);
  if (!branch) throw new Error(`branch ${code} is missing from the baseline`);
  await selectBranch(page, branch.id);
}

/** The caller's own employee id, which is whose calendar this screen shows. */
async function ownEmployeeId(api: {
  get: <T>(path: string) => Promise<T>;
}): Promise<string> {
  const me = await api.get<any>('/auth/me');
  const id = me?.employeeId ?? me?.employee?.id ?? me?.data?.employeeId;
  if (!id) throw new Error('the signed-in account has no employee record');
  return id as string;
}

test.describe('the calendar every role owns', () => {
  test('MYC-UI-01 loads with its four stat tiles for every role', async ({
    page,
    problems,
  }) => {
    // Runs in all four projects. The route is deliberately unguarded, so this
    // is the case that would catch a regression making it admin-only.
    crashesOnly(problems);
    const calendar = new MyCalendarPage(page);
    await calendar.open();

    await expect(page).toHaveURL(/\/dashboard\/my-calendar/);
    for (const key of ['workdays', 'leaves', 'overtime', 'holidays']) {
      await expect(calendar.stat(key)).toBeVisible();
    }
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the read-only role');
    });

    test('MYC-UI-02 an employee is offered no create, edit or delete control', async ({
      page,
      problems,
    }) => {
      // `CREATE_SCHEDULE`, `EDIT_SCHEDULE` and `DELETE_SCHEDULE` all resolve to
      // ADMIN + HR_MANAGER. An employee reads their roster; they do not write it.
      crashesOnly(problems);
      const calendar = new MyCalendarPage(page);
      await calendar.open();

      await expect(calendar.createButton).toHaveCount(0);
      await expect(calendar.bulkCreateButton).toHaveCount(0);

      await selectDay(page, today());
      await expect(calendar.anyEditButton).toHaveCount(0);
      await expect(calendar.anyDeleteButton).toHaveCount(0);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the other read-only role');
    });

    test('MYC-UI-03 a manager is likewise read-only here', async ({
      page,
      problems,
    }) => {
      // A manager runs a department; scheduling is an HR act. Asserted separately
      // from the employee case because the two roles reach this screen through
      // different sidebar menus and it would be easy to gate only one of them.
      crashesOnly(problems);
      const calendar = new MyCalendarPage(page);
      await calendar.open();

      await expect(calendar.createButton).toHaveCount(0);
      await expect(calendar.bulkCreateButton).toHaveCount(0);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the writing role');
    });

    test('MYC-UI-04 an admin is offered the write controls', async ({
      page,
      problems,
    }) => {
      const calendar = new MyCalendarPage(page);
      await calendar.open();

      await expect(calendar.createButton).toBeVisible();
      await expect(calendar.bulkCreateButton).toBeVisible();
      settle(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'asserted once, on a roster nobody writes');
    });

    test('MYC-UI-05 selecting a day with nothing on it shows an honest empty state', async ({
      page,
      problems,
    }) => {
      // `employee1` has no seeded schedule, so today is genuinely empty. The
      // point of the case is that the screen SAYS so rather than rendering an
      // unexplained blank panel.
      crashesOnly(problems);
      const calendar = new MyCalendarPage(page);
      await calendar.open();
      await selectDay(page, today());

      await expect(calendar.empty).toBeVisible();
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'asserted once');
    });

    test('MYC-UI-06 a failed load shows an error rather than an empty calendar', async ({
      page,
      problems,
    }) => {
      // The same class of defect as the overview's: every fetch used to
      // `console.error` and fall back to `[]`, so a refusal and a quiet month
      // looked identical. `renderOnly` because the 500 below is injected by this
      // test and a 5xx on the page is the setup working.
      renderOnly(problems);
      await page.route(
        (url) =>
          url.href.startsWith(API_URL) && url.href.includes('/calendar/stats'),
        (route) => route.fulfill({ status: 500, json: { message: 'boom' } }),
      );

      const calendar = new MyCalendarPage(page);
      await calendar.open();

      await expect(calendar.error).toBeVisible();
    });
  });
});

test.describe('creating and removing a shift from my own calendar', () => {
  test.beforeEach(async ({ page, api }) => {
    test.skip(!isProject('admin'), 'the only role that may write here');
    await pinBranch(page, api, 'HO');
    await clearToday(api);
  });

  test.afterEach(async ({ api }) => {
    if (!isProject('admin')) return;
    await clearToday(api);
  });

  /** Remove any schedule the admin owns on today, so counts start from zero. */
  async function clearToday(api: ApiClient): Promise<void> {
    const id = await ownEmployeeId(api).catch(() => null);
    if (!id) return;
    const date = today();
    const res = await api.get<any>(
      `/calendar/my-calendar?startDate=${date}&endDate=${date}&employeeId=${id}`,
    );
    const events = Array.isArray(res) ? res : (res?.data ?? []);
    for (const event of events.filter((e: any) => e.type === 'work')) {
      await api.delete(`/calendar/schedules/${event.id}`).catch(() => undefined);
    }
  }

  test('MYC-UI-07 create a shift on today and it lands on the calendar', async ({
    page,
    api,
  }) => {
    const calendar = new MyCalendarPage(page);
    const form = new ScheduleFormModal(page);
    const date = today();

    await calendar.open();
    const before = await page.locator('.fc-event').count();

    await calendar.createButton.click();
    await expect(form.form).toBeVisible();

    // The employee has to be named explicitly. `ScheduleModal` renders the
    // select for anyone who may schedule OTHERS, and seeds it from
    // `authService.getUser().employeeId` — which the stored session does not
    // carry — so on this screen it opens empty and the form refuses itself
    // before anything is sent.
    const employeeId = await ownEmployeeId(api);
    await form.employee.selectOption(employeeId);
    await form.date.fill(date);
    await form.shiftType('FULL_DAY').click();
    await form.submit.click();

    // The contract gate is CONDITIONAL here, unlike Shift Management where it
    // always fires: `ScheduleModal` only raises it when it finds the target in
    // the directory it fetched, and falls through to "has a contract" when it
    // cannot. Tolerated for that reason; the strict assertions are on the
    // outcome, which is the same either way.
    if (await form.contractWarning.isVisible().catch(() => false)) {
      await form.contractConfirm.click();
    }
    await expect(form.form).toBeHidden();

    // The server holds it…
    const stored = await api.get<any>(
      `/calendar/my-calendar?startDate=${date}&endDate=${date}&employeeId=${employeeId}`,
    );
    const events = Array.isArray(stored) ? stored : (stored?.data ?? []);
    expect(
      events.filter((e: any) => e.type === 'work'),
      'the server did not store the shift',
    ).toHaveLength(1);

    // …and the calendar grid renders it. Asserted on `.fc-event` rather than on
    // the day-detail panel for the reason MYC-UI-10 records: that panel is not
    // reachable for this role at all.
    await calendar.open();
    await expect
      .poll(() => page.locator('.fc-event').count())
      .toBe(before + 1);
  });

  test('MYC-UI-08 T26: a scheduler can open the day list and reach its controls', async ({
    page,
    api,
  }) => {
    // This was a pin until the day-click handler stopped opening the create
    // modal. FullCalendar is mounted `selectable` for anyone holding
    // `CREATE_SCHEDULE`, so their click is consumed as a range select — and
    // while `handleDateSelect` also opened the modal, the day-detail panel was
    // unreachable for exactly the two roles allowed to use the edit and delete
    // controls that live in it.
    //
    // Asserted from the role that could NOT reach it before, on a day with a
    // real shift on it, so the case fails again the moment the panel goes away.
    const employeeId = await ownEmployeeId(api);
    const date = today();
    await api.post('/calendar/schedules', {
      employeeId,
      date,
      shiftType: 'FULL_DAY',
      startTime: `${date}T09:00:00.000Z`,
      endTime: `${date}T18:00:00.000Z`,
    });

    const calendar = new MyCalendarPage(page);
    await calendar.open();
    await selectDay(page, date);

    // The panel opens instead of the modal…
    await expect(page.getByTestId('sched-form')).toHaveCount(0);
    await expect(calendar.anyDeleteButton).toBeVisible();
    await expect(calendar.anyEditButton).toBeVisible();

    // …and creating is still one click away, pre-filled with the day chosen —
    // the capability the old behaviour was buying at the panel's expense.
    await expect(calendar.dayAddButton).toBeVisible();
    await calendar.dayAddButton.click();
    await expect(page.getByTestId('sched-form')).toBeVisible();
    await expect(page.getByTestId('sched-form-date')).toHaveValue(date);
  });

  test('MYC-UI-09 T21: delete is gated on DELETE_SCHEDULE and removes the shift', async ({
    page,
    api,
  }) => {
    // Reachable only since T26 was fixed. The control used to be gated on
    // `EDIT_SCHEDULE` while `DELETE_SCHEDULE` was consulted nowhere in the app;
    // today both resolve to the same two roles, so nothing observable changed
    // when it was corrected — which is exactly why it needs a test. The next
    // time those permission sets diverge, this is what notices.
    const employeeId = await ownEmployeeId(api);
    const date = today();
    await api.post('/calendar/schedules', {
      employeeId,
      date,
      shiftType: 'FULL_DAY',
      startTime: `${date}T09:00:00.000Z`,
      endTime: `${date}T18:00:00.000Z`,
    });

    const calendar = new MyCalendarPage(page);
    await calendar.open();
    await selectDay(page, date);
    await expect(calendar.anyDeleteButton).toBeVisible();

    // The screen confirms with a native dialog, which Playwright dismisses by
    // default — without this the click is a silent no-op.
    const asked = captureNativeDialogs(page);
    await calendar.anyDeleteButton.click();

    await expect
      .poll(async () => {
        const res = await api.get<any>(
          `/calendar/my-calendar?startDate=${date}&endDate=${date}&employeeId=${employeeId}`,
        );
        const events = Array.isArray(res) ? res : (res?.data ?? []);
        return events.filter((e: any) => e.type === 'work').length;
      })
      .toBe(0);
    expect(asked.join(' ')).toMatch(/delete|remove/i);
  });

  test('MYC-UI-10 dismissing the delete confirmation keeps the shift', async ({
    page,
    api,
  }) => {
    // The half that proves the confirmation is a real gate rather than
    // decoration. A test that only ever accepts cannot tell the difference.
    const employeeId = await ownEmployeeId(api);
    const date = today();
    await api.post('/calendar/schedules', {
      employeeId,
      date,
      shiftType: 'FULL_DAY',
      startTime: `${date}T09:00:00.000Z`,
      endTime: `${date}T18:00:00.000Z`,
    });

    const calendar = new MyCalendarPage(page);
    await calendar.open();
    await selectDay(page, date);
    await expect(calendar.anyDeleteButton).toBeVisible();

    dismissNativeDialogs(page);
    await calendar.anyDeleteButton.click();
    await page.waitForTimeout(500);

    const res = await api.get<any>(
      `/calendar/my-calendar?startDate=${date}&endDate=${date}&employeeId=${employeeId}`,
    );
    const events = Array.isArray(res) ? res : (res?.data ?? []);
    expect(events.filter((e: any) => e.type === 'work')).toHaveLength(1);
  });
});
