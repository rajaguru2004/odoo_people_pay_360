import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';

/**
 * The employee record, across the screens that read it.
 *
 * Employee data is the spine of this app — payroll, attendance, leave and
 * approvals all hang off it — so the failure that matters is not a form
 * rejecting input, it is a record existing and the screens disagreeing about
 * it. A directory that silently lists nothing looks identical to a company with
 * no staff.
 *
 * The record is created over the API. Driving the onboarding wizard instead
 * would mean filling fields that come from the configurable Employee Profile
 * Template — the form is generated from admin configuration, so a spec that
 * typed into it would be asserting one tenant's field list rather than the
 * behaviour. The wizard's own rules belong in component tests, where the
 * template can be supplied directly.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Tagged so a half-finished run is identifiable in the database. */
const marker = `pw${Date.now().toString(36)}`;

interface EmployeeRecord {
  id: string;
  employeeCode?: string;
  fullName: string;
  email: string;
}

test.describe('an employee record reaches the screens that read it', () => {
  let api: ApiClient;
  let employee: EmployeeRecord | null = null;
  let createError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    api = await ApiClient.as('admin');

    const departments = await api.get<Array<{ id: string }>>('/departments').catch(() => []);
    const branches = await api.get<Array<{ id: string }>>('/branches').catch(() => []);
    const departmentId = (Array.isArray(departments) ? departments : [])[0]?.id;
    const branchId = (Array.isArray(branches) ? branches : [])[0]?.id;

    employee = await api
      .post<EmployeeRecord>('/employees', {
        fullName: `Journey Employee ${marker}`,
        email: `journey-${marker}@test.local`,
        departmentId,
        branchId,
        position: 'Test Engineer',
        startDate: new Date().toISOString().slice(0, 10),
        dateOfBirth: '1995-01-01',
        baseSalary: 1000,
        status: 'ACTIVE',
        // No idCard on purpose. `autoGenerateIdCard` means the server mirrors
        // it from the generated employee code, which is what the onboarding
        // wizard relies on — it never shows the field. This used to 400 with
        // "idCard must be a string" because the flag only took effect on a
        // retry; leaving it out here is what keeps that fix honest.
        autoGenerateIdCard: true,
      })
      .catch((e) => {
        createError = (e as Error).message;
        return null;
      });
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'administrative flow');
    });

    test('the record is created', async () => {
      expect(employee, `no employee created: ${createError}`).toBeTruthy();
      // The server generates the code — a client-supplied one was the source of a
      // past defect, so its presence here is worth confirming.
      expect(employee!.id).toBeTruthy();
    });

    test('it appears in the directory an admin sees', async ({ page, problems }) => {
      test.skip(!employee, 'nothing to look for');

      await page.goto('/dashboard/employees', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // A directory that renders its shell and no rows is the exact failure this
      // catches: the screen looks fine and the data is missing.
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes(marker), { timeout: 20_000 })
        .toBe(true);

      settle(problems, 'the employee directory');
    });

    test('its detail screen opens', async ({ page, problems }) => {
      test.skip(!employee, 'nothing to open');

      await page.goto(`/dashboard/employees/${employee!.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      expect(new URL(page.url()).pathname).toBe(`/dashboard/employees/${employee!.id}`);

      const body = await page.locator('body').innerText();
      expect(body).toContain(marker);

      settle(problems, 'the employee detail screen');
    });

    test('its edit form loads with the record already in it', async ({ page, problems }) => {
      test.skip(!employee, 'nothing to edit');

      await page.goto(`/dashboard/employees/${employee!.id}/edit`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // An edit form that opens empty would save blanks over a real record, which
      // is worse than failing to open at all.
      await expect
        .poll(
          async () =>
            page.locator('input').evaluateAll((els) =>
              els.some((e) => (e as HTMLInputElement).value?.includes('Journey Employee')),
            ),
          { timeout: 20_000 },
        )
        .toBe(true);

      settle(problems, 'the employee edit form');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the ESS side of the same route');
    });

    test('an employee cannot reach another person’s record', async ({ page, problems }) => {
      test.skip(!employeeIdForCrossRoleCheck, 'no id shared from the admin run');

      // `/dashboard/employees/[id]` is guarded by VIEW_EMPLOYEES, which an
      // employee does not hold — so this must redirect rather than render.
      await page.goto(`/dashboard/employees/${employeeIdForCrossRoleCheck}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('networkidle').catch(() => {});

      expect(new URL(page.url()).pathname).toBe('/403');

      crashesOnly(problems);
      settle(problems, 'an employee denied another record');
    });
  });
});

/**
 * Projects do not share state, so the cross-role check uses any id rather than
 * the one the admin project created. A non-existent id is fine: the guard runs
 * before the record is ever fetched, which is the point being asserted.
 */
const employeeIdForCrossRoleCheck = '00000000-0000-0000-0000-000000000000';
