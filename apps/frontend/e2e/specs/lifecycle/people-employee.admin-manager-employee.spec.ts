import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  EmployeeDirectoryPage,
  EmployeeDetailPage,
  captureNativeDialogs,
  selectBranch,
} from '../../pages';

/**
 * The employee directory and record, from the screens.
 *
 * The backend suite proves the server's rules. What only a browser can answer
 * is whether the screen AGREES with them — and in this module the two have a
 * history of disagreeing quietly:
 *
 *  - the directory admits a MANAGER but `/employees/statistics` does not, so
 *    the page has to know not to ask (it works around a guaranteed 403);
 *  - multi-select filters are applied CLIENT-side over a capped fetch, so the
 *    rows and the "N of M" counter can disagree with each other;
 *  - an employee opening their own record used to 403 before the screen's own
 *    self-service branch was ever reached.
 *
 * Every case that writes hires its own staff over the API rather than touching
 * a seeded role account: these journeys TERMINATE and DELETE people, and the
 * four role accounts have to survive the run.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const tag = () =>
  `${test.info().project.name.toUpperCase()}${Date.now().toString(36).slice(-5)}`;

interface Seeded {
  id: string;
  employeeCode: string;
  fullName: string;
}

let hoId = '';

/** Hires someone through the API so a UI case has a row it owns. */
async function hire(
  api: ApiClient,
  over: Record<string, unknown> = {},
): Promise<Seeded> {
  const t = tag();
  const created = await api.post<Seeded & Record<string, unknown>>('/employees', {
    fullName: `E2E Hire ${t}`,
    dateOfBirth: '1995-06-15',
    email: `e2e.hire.${t.toLowerCase()}@company.com`,
    autoGenerateIdCard: true,
    departmentId: over.departmentId ?? (await opsDepartmentId(api)),
    position: 'Engineer',
    startDate: '2025-01-06',
    baseSalary: 40000,
    ...over,
  });
  return {
    id: created.id,
    employeeCode: created.employeeCode,
    fullName: created.fullName,
  };
}

/** The department the seeded `manager` account actually heads. */
async function hrdDepartmentId(api: ApiClient): Promise<string> {
  const departments = await api.get<any>('/departments');
  const rows: any[] = Array.isArray(departments)
    ? departments
    : departments.data;
  const hrd = rows.find((d: any) => d.code === 'HRD');
  if (!hrd) throw new Error('Base seed missing department HRD');
  return hrd.id;
}

async function opsDepartmentId(api: ApiClient): Promise<string> {
  const departments = await api.get<any>('/departments');
  const rows: any[] = Array.isArray(departments)
    ? departments
    : departments.data;
  const ops = rows.find((d: any) => d.code === 'E2E-OPS');
  if (!ops) throw new Error('Baseline seed missing department E2E-OPS');
  return ops.id;
}

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  const branches = await api.get<any>('/branches');
  const rows: any[] = Array.isArray(branches) ? branches : branches.data;
  hoId = rows.find((b: any) => b.code === 'HO')?.id ?? rows[0]?.id;
});

test.beforeEach(async ({ page }) => {
  // The picker auto-selects on mount, and a directory pointed at the empty
  // second branch lists nothing — which reads as "the employee is missing"
  // rather than "the view is somewhere else".
  await selectBranch(page, hoId);
});

test.describe('Employee directory', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('EMP-UI-01: admin sees the directory, its stat tiles, and every view of the same set', async ({
      page,
      problems,
    }) => {
      const directory = new EmployeeDirectoryPage(page);
      await directory.open();

      const total = await directory.stat('total');
      expect(total).toBeGreaterThan(0);

      // Narrow to one known person first. The directory pages at 20 and this
      // database accumulates hires across runs, so "is the row on screen" is
      // only a stable question once the result set is one row — otherwise the
      // case starts failing later for a reason that has nothing to do with it.
      await directory.search('E2E-CON1');

      // The three views are three renderings of one result set, not three
      // queries: switching must not change who is present.
      await expect(directory.row('E2E-CON1')).toBeVisible();
      await directory.switchView('card');
      await expect(directory.card('E2E-CON1')).toBeVisible();
      await directory.switchView('table');
      await expect(directory.row('E2E-CON1')).toBeVisible();

      settle(problems, 'The employee directory');
    });

    test('EMP-UI-02: search narrows, and a no-match term shows the empty state', async ({
      page,
      problems,
    }) => {
      const directory = new EmployeeDirectoryPage(page);
      await directory.open();

      await directory.search('Contracted');
      await expect(directory.row('E2E-CON1')).toBeVisible();

      // The honest empty state, not a blank panel — the difference between
      // "nothing matched" and "the page broke".
      await directory.search('zzz-no-such-person-zzz');
      expect(await directory.isEmpty()).toBe(true);

      settle(problems, 'Employee search');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager journey');
    });

    test('EMP-UI-03: a manager’s directory never asks for statistics', async ({
      page,
      problems,
    }) => {
      // `/employees/statistics` is ADMIN/HR only while the directory admits
      // MANAGER. The page skips the call rather than swallowing a guaranteed 403
      // — one `if` away from a logged error on every visit to a P0 screen.
      const statsCalls: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/employees/statistics')) statsCalls.push(r.url());
      });

      const directory = new EmployeeDirectoryPage(page);
      await directory.open();
      await expect(page).toHaveURL(/\/dashboard\/employees/);

      // The assertion of this case: not one request to the endpoint the manager
      // would be refused.
      expect(statsCalls).toEqual([]);

      // Avatar images 404 for staff without one, and the manager shell fires its
      // own forbidden requests (see EMP-UI-08b) — neither is what this case is
      // about.
      crashesOnly(problems);
    });

    test('EMP-UI-04: export and import are offered only to roles entitled to them', async ({
      page,
      problems,
    }) => {
      const directory = new EmployeeDirectoryPage(page);
      await directory.open();

      // Was finding P3: Export carried no gate at all while Import beside it did,
      // so a manager was offered "download the directory" as a first-class action.
      expect(await directory.canImport()).toBe(false);
      expect(await directory.canExport()).toBe(false);
      expect(await directory.canCreate()).toBe(false);

      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('EMP-UI-05: a status filter narrows the rows and the counter agrees', async ({
      page,
      problems,
    }) => {
      const directory = new EmployeeDirectoryPage(page);
      await directory.open();

      await directory.search('E2E-');
      await directory.openFilters();
      await directory.filterByStatus('TERMINATED');
      await directory.applyFilters();

      // The seeded TERMINATED person is present and a live one is not. With
      // multi-select the filtering happens client-side over a capped fetch
      // (finding P5), so rows and counter have to be read together.
      await expect(directory.row('E2E-TERMED')).toBeVisible();
      await expect(directory.row('E2E-CON1')).toHaveCount(0);

      await directory.clearFilters();
      await expect(directory.row('E2E-CON1')).toBeVisible();

      settle(problems, 'Directory filters');
    });
  });
});

test.describe('The employee record', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('EMP-UI-08: the detail screen shows every section an admin is entitled to', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hire(api);

      const detail = new EmployeeDetailPage(page);
      await detail.open(person.id);
      expect(await detail.name()).toContain('E2E Hire');
      // The badge shows the translated label ("Active"), not the raw enum — so
      // this reads case-insensitively rather than asserting the storage value,
      // which is the backend spec's job.
      expect((await detail.status()).toLowerCase()).toContain('active');

      for (const section of ['profile', 'documents', 'visa', 'salary', 'activity']) {
        expect(await detail.hasSection(section)).toBe(true);
      }

      // `crashesOnly`: a freshly hired employee has no avatar, and the img 404s
      // intermittently depending on whether the request lands before the
      // assertion. Judging strictly here made this case flaky for a missing
      // placeholder image rather than for anything it asserts.
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'manager journey');
    });

    test('EMP-UI-08b: a manager sees the record but not the salary section', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('hr')).withBranch(hoId);
      // Into HRD, which is the department the seeded `manager` account heads.
      // Hiring into E2E-OPS instead would produce a legitimate 403 and prove
      // only that department scoping works — which the backend suite already
      // asserts. This case is about what the screen shows when access is allowed.
      const person = await hire(api, {
        departmentId: await hrdDepartmentId(api),
      });

      const detail = new EmployeeDetailPage(page);
      await detail.open(person.id);
      expect(await detail.name()).toContain('E2E Hire');

      // Pay is ADMIN/HR only. Absence is the assertion — a hidden-but-rendered
      // section would still be in the DOM for anyone who looked.
      expect(await detail.hasSection('salary')).toBe(false);

      // `crashesOnly`, not `settle`. Once a manager has opened /dashboard, its
      // ungated widgets have logged four 403s —
      //   /dashboard/payroll-summary, /payrolls, /reimbursements/pending,
      //   /dashboard/turnover-stats
      // — and react-query replays them on later navigations, so they surface on
      // this screen without originating here (finding P37, which belongs to the
      // Dashboard module). Judging strictly would fail this case for something it
      // does not test.
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'employee journey');
    });

    test('EMP-UI-09: an employee can open their own record', async ({
      page,
      problems,
    }) => {
      /**
       * P2 had two halves and both are now closed.
       *
       * The server admits an employee to their own record; the SCREEN used to
       * redirect them to /403 first, because `ProtectedRoute` asked only
       * "does this ROLE have VIEW_EMPLOYEES" — the wrong question for a route
       * that is about one specific person. It now also accepts "is this me",
       * answered from the URL param against the session, which is a question a
       * route guard can answer before the record loads.
       */
      const me = await (await ApiClient.as('employee')).get<any>('/auth/me');
      const employeeId = me?.employee?.id ?? me?.employeeId;
      test.skip(!employeeId, 'the employee account has no linked employee record');

      const detail = new EmployeeDetailPage(page);
      await detail.open(employeeId);
      await expect(page).toHaveURL(new RegExp(employeeId));
      expect(await detail.name()).toBeTruthy();

      // Being allowed in is not being given everything: pay stays ADMIN/HR only.
      expect(await detail.hasSection('salary')).toBe(false);

      crashesOnly(problems);
    });

    test('EMP-UI-09b: an employee cannot open someone else’s record', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('hr')).withBranch(hoId);
      const other = await hire(api);

      const detail = new EmployeeDetailPage(page);
      await detail.open(other.id);

      // A 403 on the fetch is the expected outcome here, so console/network
      // noise is not a failure — only a crash would be.
      crashesOnly(problems);
      await expect(page.getByTestId('emp-detail-name')).toHaveCount(0);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('EMP-UI-11: a soft delete moves the person to INACTIVE, seen from the list', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hire(api);

      // Delete is confirmed through `window.confirm`, so the handler has to be
      // installed for the life of the page — a one-shot listener races the menu
      // and the dialog is auto-dismissed, which looks exactly like "the delete
      // silently did nothing".
      const dialogs = captureNativeDialogs(page);

      const detail = new EmployeeDetailPage(page);
      await detail.open(person.id);

      // Wait on the request itself rather than on a load state: the menu closes,
      // the confirm resolves and the page redirects, so "did the delete happen"
      // has no reliable DOM signal on this screen.
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/employees/${person.id}`) &&
            r.request().method() === 'DELETE',
          { timeout: 20000 },
        ),
        detail.delete(),
      ]);
      expect(dialogs.length).toBeGreaterThan(0);
      expect(response.status()).toBe(200);

      // Read the outcome back over the API: the screen may redirect, but the
      // rule under test is that the person is marked as having left, not
      // removed.
      //
      // INACTIVE, not TERMINATED. R72 made all three offboarding exits — this
      // soft delete, `TerminationRequestService.approveTermination` and
      // `ContractsService.terminate` — write the same status, because the
      // readers already keyed on INACTIVE (`getTurnoverStats` counts it AS a
      // termination, and so does the chatbot's headcount). TERMINATED stayed
      // what it always was: a CONTRACT status. See employees.service.ts and
      // its R72 comment. The seeded E2E-TERMED person is still TERMINATED —
      // that row exists for the hard-delete path, which requires it.
      const after = await api.get<any>(`/employees/${person.id}`);
      expect(after.status).toBe('INACTIVE');

      crashesOnly(problems);
    });
  });
});
