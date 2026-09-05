import { test, expect, crashesOnly, ApiClient } from '../../fixtures';
import {
  VisaReportsPage,
  EmployeeVisaSection,
  EmployeeDetailPage,
  selectBranch,
} from '../../pages';

/**
 * Visa reports and the per-employee section that feeds them.
 *
 * The reports screen only READS; every record it shows was written on an
 * employee's Visa tab. So the journey worth having is the round trip: issue a
 * visa on the person, find it in the report, follow the report's row back to
 * the person.
 *
 * The renewal is the case that matters most. A renewal is not an edit — the old
 * record becomes RENEWED and a new one takes its place as current — and if that
 * ever collapsed into an overwrite the expiry cron would start alerting on a
 * document nobody holds any more, with no screen showing anything wrong.
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

async function hire(api: ApiClient) {
  const t = tag();
  return api.post<any>('/employees', {
    fullName: `Visa Subject ${t}`,
    dateOfBirth: '1993-03-03',
    email: `visa.${t.toLowerCase()}@company.com`,
    autoGenerateIdCard: true,
    departmentId: opsDeptId,
    position: 'Engineer',
    startDate: '2025-01-06',
    baseSalary: 35000,
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

test.describe('Visa reports', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('VISA-UI-01: admin sees the report and its summary tiles', async ({
      page,
      problems,
    }) => {
      const reports = new VisaReportsPage(page);
      await reports.open();

      // The baseline seeds one visa expiring in 20 days and one already expired,
      // so these tiles have something honest to count.
      await expect(reports.row('E2E-VISA-EXPIRING')).toBeVisible();
      expect(await reports.summary('active')).not.toBe('—');

      crashesOnly(problems);
    });

    test('VISA-UI-02: the filters narrow, and a combination reaches the empty state', async ({
      page,
      problems,
    }) => {
      const reports = new VisaReportsPage(page);
      await reports.open();

      // The expiring window is the filter the whole screen exists for.
      await reports.filter({ expiringInDays: '30' });
      await expect(reports.row('E2E-VISA-EXPIRING')).toBeVisible();

      await reports.filter({ expiringInDays: '7' });
      await expect(reports.row('E2E-VISA-EXPIRING')).toHaveCount(0);

      await reports.filter({ expiringInDays: '' });
      await reports.search('zzz-no-such-visa-zzz');
      // The search refetches server-side, so a single read races the response —
      // poll for the empty state rather than assuming `networkidle` covered it.
      await expect.poll(() => reports.isEmpty(), { timeout: 10000 }).toBe(true);

      crashesOnly(problems);
    });

    test('VISA-UI-03: a row click lands on the employee with the visa tab open', async ({
      page,
      problems,
    }) => {
      const reports = new VisaReportsPage(page);
      await reports.open();
      await reports.openEmployeeVisa('E2E-VISA-EXPIRING');

      // The deep link is the only navigation between these two screens, and it
      // carries the section in the query string.
      await expect(page).toHaveURL(/\/dashboard\/employees\/.*section=visa/);
      await expect(page.getByTestId('visa-row-E2E-VISA-EXPIRING')).toBeVisible();

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

    test('VISA-UI-06: manager and employee are refused the report', async ({
      page,
      problems,
    }) => {
      // This screen guards by ROLE rather than by permission name, unlike the
      // rest of the module — so it is the one People route where a manager is
      // redirected rather than shown an empty list.
      await page.goto('/dashboard/visa-reports', {
        waitUntil: 'domcontentloaded',
      });
      await expect(page).toHaveURL(/\/403/);

      crashesOnly(problems);
    });
  });
});

test.describe('The employee visa section', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'admin journey');
  });

  test('VISA-UI-04: issue, then renew — the old record becomes history, not an edit', async ({
    page,
    problems,
  }) => {
    const api = (await ApiClient.as('admin')).withBranch(hoId);
    const person = await hire(api);
    const first = `UIV-${tag()}`;

    const detail = new EmployeeDetailPage(page);
    await detail.open(person.id, 'visa');
    const visas = new EmployeeVisaSection(page);

    await visas.add();
    await visas.fill({
      number: first,
      country: 'Oman',
      issueDate: '2026-01-01',
      expiryDate: daysFromNow(120),
    });
    const [created] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/legal-documents') &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      ),
      visas.submit(),
    ]);
    expect(
      created.status(),
      `create refused: ${await created.text().catch(() => '')}`,
    ).toBeLessThan(300);
    await expect(visas.row(first)).toBeVisible();

    // Renew it. The renewal issues a NEW document, so the number and dates are
    // re-entered rather than edited.
    const second = `UIV2-${tag()}`;
    await visas.renew(first);
    await visas.fill({
      number: second,
      issueDate: daysFromNow(0),
      expiryDate: daysFromNow(500),
    });
    const [renewed] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/renew') && r.request().method() === 'POST',
        { timeout: 20000 },
      ),
      visas.submit(),
    ]);
    expect(
      renewed.status(),
      `renew refused: ${await renewed.text().catch(() => '')}`,
    ).toBeLessThan(300);

    // Read the chain back: exactly one current record, and the old one kept as
    // history rather than overwritten.
    const chain = await api.get<any>(`/legal-documents/employee/${person.id}`);
    const rows: any[] = Array.isArray(chain) ? chain : chain.data;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: any) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r: any) => r.documentNumber === first).status).toBe(
      'RENEWED',
    );
    expect(rows.find((r: any) => r.documentNumber === second).isCurrent).toBe(
      true,
    );

    crashesOnly(problems);
  });

  test('VISA-UI-04b: a second current visa for the same country is refused', async ({
    page,
    problems,
  }) => {
    const api = (await ApiClient.as('admin')).withBranch(hoId);
    const person = await hire(api);
    await api.post('/legal-documents', {
      employeeId: person.id,
      documentNumber: `UIVX-${tag()}`,
      documentType: 'Employment Visa',
      country: 'Oman',
      issueDate: '2026-01-01',
      expiryDate: daysFromNow(200),
    });

    const detail = new EmployeeDetailPage(page);
    await detail.open(person.id, 'visa');
    const visas = new EmployeeVisaSection(page);
    await visas.add();
    await visas.fill({
      number: `UIVY-${tag()}`,
      country: 'Oman',
      issueDate: '2026-02-01',
      expiryDate: daysFromNow(300),
    });

    const [refused] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/legal-documents') &&
          r.request().method() === 'POST',
        { timeout: 20000 },
      ),
      visas.submit(),
    ]);
    // One current visa per employee AND country — the server refuses, and the
    // point of this case is that the screen surfaces it rather than appearing
    // to succeed.
    expect(refused.status()).toBe(409);

    crashesOnly(problems);
  });
});
