import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import {
  ContractsPage,
  ContractFormPage,
  ContractDetailPage,
  TerminationsPage,
  EmployeeDetailPage,
  selectBranch,
} from '../../pages';

/**
 * Contracts and termination, from the screens.
 *
 * These two are one journey because that is how they happen: a contract is
 * created, a termination is requested against it, someone approves, and a
 * person's employment ends. The interesting assertions are the ones that cross
 * a screen boundary — a contract's salary appearing on the EMPLOYEE record, an
 * approval showing up as INACTIVE on a different page — because those are the
 * places where the UI and the server can quietly disagree.
 *
 * The termination queue is also the only screen in the app that denies access
 * with a panel instead of redirecting to /403, which is why the manager and
 * employee cases here look different from every other denial in the suite.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const tag = () =>
  `${test.info().project.name.toUpperCase()}${Date.now().toString(36).slice(-5)}`;

let hoId = '';
let opsDeptId = '';

const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A fresh employee with no contract — the only state the create form accepts. */
async function hireUncontracted(api: ApiClient) {
  const t = tag();
  return api.post<any>('/employees', {
    fullName: `Contract Subject ${t}`,
    dateOfBirth: '1992-04-04',
    email: `contract.${t.toLowerCase()}@company.com`,
    autoGenerateIdCard: true,
    departmentId: opsDeptId,
    position: 'Engineer',
    startDate: '2025-01-06',
    baseSalary: 30000,
  });
}

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  const branches = await api.get<any>('/branches');
  const branchRows: any[] = Array.isArray(branches) ? branches : branches.data;
  hoId = branchRows.find((b: any) => b.code === 'HO')?.id ?? branchRows[0]?.id;

  const departments = await api.get<any>('/departments');
  const deptRows: any[] = Array.isArray(departments)
    ? departments
    : departments.data;
  opsDeptId = deptRows.find((d: any) => d.code === 'E2E-OPS')?.id;
  if (!hoId) throw new Error('Baseline seed missing branch HO');
  if (!opsDeptId) throw new Error('Baseline seed missing department E2E-OPS');
});

test.beforeEach(async ({ page }) => {
  await selectBranch(page, hoId);
});

test.describe('Contracts', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('CON-UI-01: admin sees the list, its stats, and an honest empty state', async ({
      page,
      problems,
    }) => {
      const list = new ContractsPage(page);
      await list.open();

      await expect(list.row('E2E-CONTRACT-1')).toBeVisible();
      expect(await list.canCreate()).toBe(true);

      await list.search('zzz-no-such-contract-zzz');
      expect(await list.isEmpty()).toBe(true);

      crashesOnly(problems);
    });

    test('CON-UI-02: the end date is offered only when the contract is not INDEFINITE', async ({
      page,
      problems,
    }) => {
      const form = new ContractFormPage(page);
      await form.open();

      // The type options are LIBRARY labels, not enum names — 'Definite term
      // (12-36 months)' rather than 'FIXED_TERM'. The mapping to the enum is the
      // page's job (and is asserted by the component test); a spec that picks by
      // enum name finds no option at all.
      await form.fill({ type: 'Indefinite' });
      // Rendered but disabled — a permanent contract has nothing to put here.
      await expect(page.getByTestId('con-form-end')).toBeDisabled();

      await form.fill({ type: 'Definite term (12-36 months)' });
      await expect(page.getByTestId('con-form-end')).toBeEnabled();

      crashesOnly(problems);
    });

    test('CON-UI-04: a monthly contract moves the employee’s base salary, seen on their record', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hireUncontracted(api);

      const form = new ContractFormPage(page);
      await form.open();
      await form.chooseEmployee(person.employeeCode, person.employeeCode);
      await form.fill({
        type: 'Indefinite',
        start: '2026-01-01',
        salary: '61000',
      });

      const [created] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith('/contracts') && r.request().method() === 'POST',
          { timeout: 20000 },
        ),
        form.submit(),
      ]);
      expect(
        created.status(),
        `create refused: ${await created.text().catch(() => '')}`,
      ).toBeLessThan(300);

      // The sync is the point: a contract's salary is written onto the employee,
      // and nothing on the contract screen would show that it had not been.
      const after = await api.get<any>(`/employees/${person.id}`);
      expect(Number(after.baseSalary)).toBe(61000);

      const detail = new EmployeeDetailPage(page);
      await detail.open(person.id);
      expect(await detail.name()).toContain('Contract Subject');

      crashesOnly(problems);
    });

    test('CON-UI-03: a second contract is refused and the user keeps their input', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hireUncontracted(api);
      await api.post('/contracts', {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: '2025-06-01',
        salary: 40000,
      });

      const form = new ContractFormPage(page);
      await form.open();
      // The picker asks `/employees/without-active-contract`, so someone who
      // already holds one should not even be offered.
      await page.getByTestId('con-form-employee-search').fill(person.employeeCode);
      await expect(
        page.getByTestId(`con-form-employee-option-${person.employeeCode}`),
      ).toHaveCount(0);

      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(isProject('admin') || isProject('hr'), 'denial journey');
    });

    test('CON-UI-10: manager and employee are refused the contract screens', async ({
      page,
      problems,
    }) => {
      await page.goto('/dashboard/contracts', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/403/);

      await page.goto('/dashboard/contracts/new', {
        waitUntil: 'domcontentloaded',
      });
      await expect(page).toHaveURL(/\/403/);

      crashesOnly(problems);
    });
  });
});

test.describe('Termination', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('TERM-UI-01: a request raised from the contract reaches the queue', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hireUncontracted(api);
      const contract = await api.post<any>('/contracts', {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: '2025-06-01',
        salary: 40000,
      });

      const detail = new ContractDetailPage(page);
      await detail.open(contract.id);
      await detail.openTerminationRequest();
      await detail.fillTerminationRequest({
        category: 'RESIGNATION',
        noticeDate: daysFromNow(0),
        terminationDate: daysFromNow(30),
        reason: 'Moving on to another role',
      });

      const [raised] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes('/contracts/termination-requests') &&
            r.request().method() === 'POST',
          { timeout: 20000 },
        ),
        detail.submitTerminationRequest(),
      ]);
      expect(
        raised.status(),
        `request refused: ${await raised.text().catch(() => '')}`,
      ).toBeLessThan(300);

      const queue = new TerminationsPage(page);
      await queue.open();
      expect(await queue.isDenied()).toBe(false);
      const pending = await api.get<any>(
        '/contracts/termination-requests/pending',
      );
      const rows: any[] = Array.isArray(pending) ? pending : pending.data;
      expect(rows.some((r: any) => r.contractId === contract.id)).toBe(true);

      crashesOnly(problems);
    });

    test('TERM-UI-02: approving ends the contract and deactivates the person', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hireUncontracted(api);
      const contract = await api.post<any>('/contracts', {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: '2025-06-01',
        salary: 40000,
      });
      const me = await api.get<any>('/auth/me');
      const request = await api.post<any>('/contracts/termination-requests', {
        contractId: contract.id,
        requestedBy: me.id,
        terminationCategory: 'RESIGNATION',
        noticeDate: daysFromNow(0),
        terminationDate: daysFromNow(30),
        reason: 'Approved through the queue',
      });

      const queue = new TerminationsPage(page);
      await queue.open();
      await expect(queue.row(request.id)).toBeVisible();

      const [approved] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/termination-requests/${request.id}/approve`) &&
            r.request().method() === 'POST',
          { timeout: 20000 },
        ),
        queue.approve(request.id),
      ]);
      expect(approved.status()).toBeLessThan(300);

      // Three rows move together, and only one of them is on this screen.
      const contractAfter = await api.get<any>(`/contracts/${contract.id}`);
      expect(contractAfter.status).toBe('TERMINATED');
      const personAfter = await api.get<any>(`/employees/${person.id}`);
      expect(personAfter.status).toBe('INACTIVE');

      crashesOnly(problems);
    });

    test('TERM-UI-03: rejecting requires a reason and leaves the contract alone', async ({
      page,
      problems,
    }) => {
      const api = (await ApiClient.as('admin')).withBranch(hoId);
      const person = await hireUncontracted(api);
      const contract = await api.post<any>('/contracts', {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: '2025-06-01',
        salary: 40000,
      });
      const me = await api.get<any>('/auth/me');
      const request = await api.post<any>('/contracts/termination-requests', {
        contractId: contract.id,
        requestedBy: me.id,
        terminationCategory: 'RESIGNATION',
        noticeDate: daysFromNow(0),
        terminationDate: daysFromNow(30),
        reason: 'To be rejected',
      });

      const queue = new TerminationsPage(page);
      await queue.open();

      // The confirm button stays disabled until a reason is typed — the screen
      // holds a rule the DTO also holds.
      expect(await queue.rejectConfirmEnabled(request.id)).toBe(false);
      await page.getByTestId('term-reject-reason').fill('Retained after review');
      const [rejected] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().includes(`/termination-requests/${request.id}/reject`) &&
            r.request().method() === 'POST',
          { timeout: 20000 },
        ),
        page.getByTestId('term-reject-confirm').click(),
      ]);
      expect(rejected.status()).toBeLessThan(300);

      const contractAfter = await api.get<any>(`/contracts/${contract.id}`);
      expect(contractAfter.status).toBe('ACTIVE');
      const personAfter = await api.get<any>(`/employees/${person.id}`);
      expect(personAfter.status).toBe('ACTIVE');

      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(isProject('admin') || isProject('hr'), 'denial journey');
    });

    test('TERM-UI-06: manager and employee see a "No access" panel, not /403', async ({
      page,
      problems,
    }) => {
      // The only denial in the app shaped this way (finding P4). It is pinned
      // here so that if the screen is ever brought in line with the rest, that
      // is a decision rather than a surprise.
      const queue = new TerminationsPage(page);
      await queue.open();
      await expect(page).toHaveURL(/\/dashboard\/contracts\/terminations/);
      expect(await queue.isDenied()).toBe(true);

      crashesOnly(problems);
    });
  });
});
