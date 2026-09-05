import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AttendanceClockPage } from '../../pages';

/**
 * Clocking in and out, through the camera the real screen uses.
 *
 * This is the flow with the largest blast radius that no test touched: every
 * employee performs it twice a day, it feeds payroll's work-day count, and it is
 * the only critical action in the app that is not a form submit. `FaceCheckIn`
 * mounts a `<video>` fed by `getUserMedia` and posts a frame grabbed from it —
 * so a broken camera path, a broken upload and a broken settings read all
 * produce the same symptom (a button that does nothing), and none of them are
 * visible to a component test.
 *
 * Two environment facts this depends on, both pinned in `seed-e2e-baseline.ts`
 * rather than assumed:
 *
 *   - `face_recognition_enabled = false` — the capture screen still appears and
 *     the frame is still sent, the backend stores it instead of matching it.
 *     Left at its default of `true`, every check-in button is disabled until the
 *     employee enrols a face and this journey cannot run at all.
 *   - `allow_multiple_checkin = true`, which is what lets a completed session be
 *     followed by another one — the multi-session shape asserted below.
 *
 * It WRITES today's attendance for the seeded employee and runs serially. There
 * is no endpoint that deletes an attendance row, so it cannot reset itself: the
 * clean starting state comes from the per-run database clone. Run
 * `npm run e2e:db reset` before a repeat run, or the first assertion here will
 * be answered by yesterday's leftovers.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface TodayRecord {
  id?: string;
  checkIn?: string | null;
  checkOut?: string | null;
  sessions?: unknown[];
}

test.describe('an employee clocks a working day', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the employee owns their own attendance');
  });

  let api: ApiClient;
  /** Today's record before this file touched anything. */
  let startedClean = false;

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    api = await ApiClient.as('employee');
    const today = await api.get<TodayRecord | null>('/attendances/today').catch(() => null);
    startedClean = !today?.checkIn;
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('an unclocked day offers check-in and refuses check-out', async ({ page, problems }) => {
    test.skip(!startedClean, 'today already has attendance — run `npm run e2e:db reset` first');

    const clock = new AttendanceClockPage(page);
    await clock.open();

    await clock.expectState(null);
    expect(await clock.canCheckIn(), 'check-in was not offered on an unclocked day').toBe(true);
    // The pairing is the rule: you cannot leave a day you never entered.
    expect(await clock.canCheckOut(), 'check-out was offered before any check-in').toBe(false);

    settle(problems, 'an unclocked day');
  });

  test('checking in through the camera moves the screen to checked-in', async ({ page, problems }) => {
    test.skip(!startedClean, 'today already has attendance — run `npm run e2e:db reset` first');

    const clock = new AttendanceClockPage(page);
    await clock.open();
    await clock.checkIn();

    // Reloaded rather than trusted: the failure this is written for is a screen
    // that reports success while nothing was stored.
    await clock.open();
    await clock.expectState('checked-in');
    expect(await clock.canCheckIn(), 'check-in stayed available while already checked in').toBe(false);
    expect(await clock.canCheckOut(), 'check-out was not offered after checking in').toBe(true);

    settle(problems, 'checking in');
  });

  test('the record exists on the server, not only on screen', async () => {
    test.skip(!startedClean, 'today already has attendance — run `npm run e2e:db reset` first');

    const today = await api.get<TodayRecord | null>('/attendances/today');
    expect(today, 'no attendance record exists for today').toBeTruthy();
    expect(today?.checkIn, 'the record has no check-in time').toBeTruthy();
  });

  test('checking out closes the session', async ({ page, problems }) => {
    test.skip(!startedClean, 'today already has attendance — run `npm run e2e:db reset` first');

    const clock = new AttendanceClockPage(page);
    await clock.open();
    await clock.checkOut();

    await clock.open();
    await clock.expectState('checked-out');
    expect(await clock.canCheckOut(), 'check-out stayed available after the session closed').toBe(false);

    const today = await api.get<TodayRecord | null>('/attendances/today');
    expect(today?.checkOut, 'the closed session has no check-out time on the server').toBeTruthy();

    settle(problems, 'checking out');
  });

  test('a second session is allowed, and the timeline counts both', async ({ page, problems }) => {
    test.skip(!startedClean, 'today already has attendance — run `npm run e2e:db reset` first');

    const clock = new AttendanceClockPage(page);
    await clock.open();

    // With allow_multiple_checkin on, a completed day is re-openable. This is
    // the flexible-shift shape: several sessions add up to the day's hours. If
    // the flag were being ignored, this button would be gone.
    expect(await clock.canCheckIn(), 'a second check-in was refused although multiple sessions are enabled').toBe(true);

    const before = await clock.sessionCount();
    await clock.checkIn();
    await clock.open();
    await clock.expectState('checked-in');

    await expect
      .poll(() => clock.sessionCount(), { timeout: 15_000 })
      .toBeGreaterThan(before);

    settle(problems, 'a second session');
  });
});

/**
 * The administrative view of the same data.
 *
 * Separate from the employee half because it fails for different reasons: the
 * management screen is branch-scoped and permission-gated, and either can break
 * without clocking itself being touched.
 */
test.describe('attendance reaches the screens that read it', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'HR half');
    });

    test('HR can open attendance management without the page breaking', async ({ page, problems }) => {
      await page.goto('/dashboard/attendance/management', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // The assertion that matters is that the screen rendered its own shell
      // rather than an error boundary; the failure fixture judges the rest.
      await expect(page.locator('h1, h2').first()).toBeVisible();

      settle(problems, 'attendance management');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee half');
    });

    test('an employee cannot read the whole company’s attendance', async ({ page, problems }) => {
      // A 403 logged by a screen this role may not use is the system working, so
      // only a thrown render or a 5xx counts as a failure here.
      crashesOnly(problems);
      await page.goto('/dashboard/attendance/management', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // Either the client guard turned them away or the API refused the data —
      // both are acceptable. Listing everyone's rows is not, and neither is a
      // crash, which the fixture catches on its own.
      if (!page.url().includes('/403')) {
        const rows = await page.locator('table tbody tr').count();
        expect(rows, 'an employee was shown the full attendance table').toBeLessThanOrEqual(1);
      }

      settle(problems, 'an employee at attendance management');
    });
  });
});
