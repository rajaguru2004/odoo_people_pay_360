import { test, expect, settle, ApiClient, runId } from '../../fixtures';

/**
 * The Employee Profile Template kill switch, from the browser.
 *
 * `employee_template_enabled` is one row in `system_settings`, and it decides
 * whether the employee create/edit screens render the ADMIN-configured template
 * or the shipped baseline. It ships OFF, so the question this spec answers is
 * the merge-gate one: **with the switch off, nothing changed** — and, so that
 * claim means something, **with it on, something did**.
 *
 * ## Why a field has to be added first
 *
 * On a fresh database the seeded company template is a byte-for-byte copy of
 * the legacy baseline, by design — that is what makes the feature safe to
 * deploy. Flipping the flag on such a database therefore changes nothing
 * visible, and a spec that flipped it and asserted "the form still renders"
 * would pass whether or not the flag did anything at all. So this spec first
 * configures the template with one field the baseline cannot know about, and
 * then uses that field's presence as the evidence: absent while off, rendered
 * while on, absent again once restored.
 *
 * ## Why nothing here reads a Settings screen
 *
 * The "Employee Fields" tab was removed from Settings, so the flag has no
 * control surface left in the portal — it is set through the API. The evidence
 * is therefore the FORM alone: the configured field is absent while off and
 * rendered while on.
 *
 * ## Shared state, and the rule that follows from it
 *
 * The flag is environment-wide: a run that leaves it on hands the feature,
 * switched on, to every suite after it. `afterAll` restores it unconditionally
 * and then re-reads it, mirroring `apps/backend/test/utils/template-flag.ts`.
 * Run this against its own database — see docs/TESTING.md.
 *
 * Note for a deployment with `DEV_MODE_ENFORCED=true`: `employee_template_enabled`
 * is a developer-owned key, so `POST /system-settings` would then need a live
 * elevation token and these tests would have to step up first. The e2e stack
 * runs unenforced, which is why plain ADMIN suffices here.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const FLAG = 'employee_template_enabled';

/** Configured on the company template; the baseline has no way to produce it. */
const MARKER_KEY = `pw_flag_${runId}`;
const MARKER_TESTID = `field-${MARKER_KEY}`;
/** A field the baseline renders too — the control for "the form still works". */
const BASELINE_TESTID = 'field-fullName';

interface SettingRow {
  key: string;
  value: string;
}

/** `null` means the row is absent, which is NOT the same as `'false'`. */
async function readFlag(api: ApiClient): Promise<string | null> {
  const rows = await api.get<SettingRow[]>('/system-settings');
  return (Array.isArray(rows) ? rows : []).find((r) => r.key === FLAG)?.value ?? null;
}

async function setFlag(api: ApiClient, on: boolean): Promise<void> {
  await api.post('/system-settings', { settings: { [FLAG]: on ? 'true' : 'false' } });
}

/** Loads the create wizard and waits for the template-driven step to render. */
async function openNewEmployee(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/dashboard/employees/new', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  // Step 1 is rendered from the template, so this is also the proof that the
  // template resolved at all rather than leaving the wizard on its skeleton.
  await expect(page.getByTestId(BASELINE_TESTID)).toBeVisible({ timeout: 20_000 });
}

test.describe('the employee profile template kill switch', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'administrative flow');
  });

  let api: ApiClient;
  /** What the flag was before this file touched it. */
  let flagBefore: string | null = null;
  let templateId = '';
  let markerFieldId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');

    try {
      flagBefore = await readFlag(api);
      // Every assertion below starts from the shipping default, whatever the
      // database happened to be left in.
      await setFlag(api, false);

      const templates = await api.get<Array<{ id: string; scope: string }>>('/profile-templates');
      const company = (Array.isArray(templates) ? templates : []).find((t) => t.scope === 'COMPANY');
      // A database that has never had one is legitimate — the resolver falls
      // back to the baseline — so adopt a preset rather than skipping.
      templateId =
        company?.id ??
        (
          await api.post<{ id: string }>('/profile-templates/adopt', {
            country: 'IN',
            scope: 'COMPANY',
          })
        ).id;

      const detail = await api.get<{
        sections: Array<{ id: string; wizardStep: number; isActive: boolean }>;
      }>(`/profile-templates/${templateId}`);
      // Step 1 specifically: the create wizard renders one step at a time, and
      // a field parked on step 3 would be invisible without clicking through
      // validation the spec has no business exercising.
      const section = detail.sections.find((s) => s.wizardStep === 1 && s.isActive);
      if (!section) throw new Error('the company template has no active step-1 section');

      const field = await api.post<{ id: string }>(`/profile-templates/${templateId}/fields`, {
        fieldKey: MARKER_KEY,
        sectionId: section.id,
        label: `PW Flag Marker ${runId}`,
        fieldType: 'TEXT',
        // Optional on purpose: a required custom field would make every other
        // suite's employee creation fail for the minutes this one is on.
        required: false,
        displayOrder: 99,
      });
      markerFieldId = field.id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    try {
      // Order matters: the flag first. If the field cleanup throws, the switch
      // is already back off and no other suite inherits the feature.
      if (api) {
        // `flagBefore === null` means the row did not exist. There is no API to
        // delete a setting, so restore the shipped default — which is what the
        // absent row resolves to anyway (`getSetting(key, 'false')`).
        await setFlag(api, flagBefore === 'true');

        if (markerFieldId) {
          await api
            .delete(`/profile-templates/${templateId}/fields/${markerFieldId}`)
            .catch(() => undefined); // archived-or-gone is the desired end state
        }

        const now = await readFlag(api);
        const expected = flagBefore === 'true' ? 'true' : 'false';
        if (now !== expected) {
          throw new Error(`${FLAG} leaked: expected ${expected}, found ${JSON.stringify(now)}`);
        }
      }
    } finally {
      await api?.dispose();
    }
  });

  test('setup completed', async () => {
    expect(setupError, 'the template could not be configured').toBe('');
    expect(markerFieldId).toBeTruthy();
  });

  test('with the switch off the wizard renders and a hire can still be created', async ({
    page,
    problems,
  }) => {
    test.skip(!!setupError, 'setup failed');

    expect(await readFlag(api)).toBe('false');

    await openNewEmployee(page);

    // The configured field exists in the database and must NOT reach the form:
    // off means the pre-template baseline, not "the template minus a bit".
    await expect(page.getByTestId(MARKER_TESTID)).toHaveCount(0);
    // The wizard is usable, not merely painted.
    await expect(page.getByTestId('onboard-next')).toBeVisible();

    // The merge gate: hiring still works with the feature switched off. Created
    // over the API for the reason employee.spec.ts gives — driving the wizard
    // would be asserting one tenant's field list rather than the behaviour.
    const departments = await api.get<Array<{ id: string }>>('/departments').catch(() => []);
    const branches = await api.get<Array<{ id: string }>>('/branches').catch(() => []);
    const employee = await api.post<{ id: string }>('/employees', {
      fullName: `Template Flag Off ${runId}`,
      email: `tmpl-off-${runId}@test.local`,
      departmentId: (Array.isArray(departments) ? departments : [])[0]?.id,
      branchId: (Array.isArray(branches) ? branches : [])[0]?.id,
      position: 'Test Engineer',
      startDate: new Date().toISOString().slice(0, 10),
      dateOfBirth: '1995-01-01',
      baseSalary: 1000,
      status: 'ACTIVE',
      autoGenerateIdCard: true,
    });
    expect(employee.id).toBeTruthy();

    settle(problems, 'the new-employee wizard with the template off');
  });

  test('switching it on renders the configured field', async ({ page, problems }) => {
    test.skip(!!setupError, 'setup failed');

    await setFlag(api, true);
    expect(await readFlag(api)).toBe('true');

    await openNewEmployee(page);

    // The whole point: a field that exists only in the admin's configuration is
    // now on the form the user fills in.
    await expect(page.getByTestId(MARKER_TESTID)).toBeVisible({ timeout: 20_000 });
    // …without costing the baseline its own fields.
    await expect(page.getByTestId(BASELINE_TESTID)).toBeVisible();

    settle(problems, 'the new-employee wizard with the template on');
  });

  test('switching it back off restores the previous form', async ({ page, problems }) => {
    test.skip(!!setupError, 'setup failed');

    await setFlag(api, false);
    expect(await readFlag(api)).toBe('false');

    await openNewEmployee(page);

    // Reverting is the property the kill switch exists for: the configured
    // field disappears and the baseline form is back, with nothing deleted.
    await expect(page.getByTestId(MARKER_TESTID)).toHaveCount(0);
    await expect(page.getByTestId('onboard-next')).toBeVisible();

    settle(problems, 'the new-employee wizard after the template was switched back off');
  });
});
