import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AttendanceCorrectionsPage, SettingsPage } from '../../pages';

/**
 * System settings — the screen that configures the client.
 *
 * 4600 lines, no validation layer, and its values gate whole modules elsewhere.
 * It is deliberately NOT covered control-by-control; that would be a test of the
 * form library. What is covered is the property the screen exists for: a value
 * an admin saves must survive a reload AND reach the screen that reads it. Every
 * interesting failure here is one of the two halves silently not happening —
 * a save that never persists, or a persisted value nothing consumes.
 *
 * `monthly_attendance_request_limit` is the setting under test because it is
 * the cheapest one with a visible downstream consumer: it caps how many
 * attendance corrections an employee may file per month, and the corrections
 * screen renders the quota. Changing it proves the whole chain.
 *
 * This file WRITES a system setting and puts it back afterwards. It runs
 * serially, and the restore is in `afterAll` so a mid-run failure still leaves
 * the baseline value behind for the rest of the suite.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** What the baseline pins it to. The restore target, not an assumption. */
const BASELINE_LIMIT = '50';
const NEW_LIMIT = '7';

test.describe('an admin changes a system setting', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'admin owns system settings');
  });

  let api: ApiClient;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    // Put it back over the API rather than through the screen: this must happen
    // even if the UI path is what broke.
    await api
      ?.post('/system-settings', { settings: { monthly_attendance_request_limit: BASELINE_LIMIT } })
      .catch(() => {});
    await api?.dispose();
  });

  test('the operator tabs are offered to an admin', async ({ page, problems }) => {
    const settings = new SettingsPage(page);
    await settings.open();

    expect(await settings.hasTab('system'), 'an admin was not offered the System Settings tab').toBe(true);
    expect(await settings.canSave(), 'the save control is missing from the settings screen').toBe(true);

    settle(problems, 'the settings screen for an admin');
  });

  test('a changed value is saved and survives a reload', async ({ page, problems }) => {
    const settings = new SettingsPage(page);
    await settings.open();
    await settings.openTab('system');

    expect(await settings.correctionLimit(), 'the screen did not load the stored value').toBe(BASELINE_LIMIT);

    await settings.setCorrectionLimit(NEW_LIMIT);
    await settings.save();

    // Reload, not re-read: an unsaved form holds the new value in React state
    // and looks identical to a saved one.
    await settings.open();
    await settings.openTab('system');
    await expect.poll(() => settings.correctionLimit(), { timeout: 15_000 }).toBe(NEW_LIMIT);

    settle(problems, 'saving a system setting');
  });

  test('the saved value is what the server holds', async () => {
    const all = await api.get<Array<{ key: string; value: string }>>('/system-settings');
    const row = (Array.isArray(all) ? all : []).find((s) => s.key === 'monthly_attendance_request_limit');
    expect(row?.value, 'the setting was not persisted server-side').toBe(NEW_LIMIT);
  });

  test('the screen that consumes the setting sees the new value', async ({ page, problems }) => {
    // The half that a settings test usually skips. A value that saves but that
    // nothing reads is indistinguishable from a working feature until a client
    // asks why the limit they set does nothing.
    const employeeApi = await ApiClient.as('employee');
    try {
      const usage = await employeeApi.get<{ limit: number; unlimited: boolean }>(
        '/attendance-corrections/my-usage',
      );
      expect(usage.limit, 'the corrections quota did not follow the setting').toBe(Number(NEW_LIMIT));
    } finally {
      await employeeApi.dispose();
    }

    const corrections = new AttendanceCorrectionsPage(page);
    await corrections.open();

    settle(problems, 'the corrections screen after a settings change');
  });
});

test.describe('settings are gated by role', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'HR view');
    });

    test('HR is not offered the operator-level tabs', async ({ page, problems }) => {
      // The screen is open to everyone — it also holds personal preferences — but
      // the System / Branding / Payroll tabs are ADMIN-only, and their save path
      // writes `system_settings`. HR seeing them would be a privilege leak.
      crashesOnly(problems);

      const settings = new SettingsPage(page);
      await settings.open();

      expect(await settings.hasTab('system'), 'HR was offered the ADMIN-only System Settings tab').toBe(false);
      expect(await settings.hasTab('branding'), 'HR was offered the ADMIN-only Branding tab').toBe(false);

      settle(problems, 'the settings screen for HR');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee view');
    });

    test('an employee cannot write a system setting even by API', async () => {
      // The client guard is only half of it. If the endpoint were open, hiding
      // the tab would be decoration.
      const api = await ApiClient.as('employee');
      try {
        await expect(
          api.post('/system-settings', { settings: { monthly_attendance_request_limit: '99' } }),
          'an employee was allowed to write a system setting',
        ).rejects.toThrow();
      } finally {
        await api.dispose();
      }
    });
  });
});
