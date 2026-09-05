import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { BankMigrationPage, selectBranch } from '../../pages';

/**
 * The bank migration screen — legacy free-text to Bank Master.
 *
 * Employees onboarded before the Bank Master carry their bank as loose text on
 * `EmployeeProfile`. Nothing can be paid from that: WPS needs a `Bank` row, a
 * validated account and a country whose field schema it can check against. This
 * screen is where HR converts one, verifying the legacy record rather than
 * accepting a new instruction — so it bypasses the approval chain entirely and
 * writes `source: 'MIGRATION'`.
 *
 * The list is the assertion that matters: an employee who has been migrated
 * must LEAVE it. A screen that kept showing them would have HR migrating the
 * same person repeatedly, each pass overwriting the last.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

interface Candidate {
  id: string;
  fullName: string;
  countries?: string[];
  profile?: { bankName?: string | null };
}

test.describe('bank migration', () => {
  let api: ApiClient;
  let branchId = '';
  let candidates: Candidate[] = [];

  test.beforeAll(async () => {
    api = await ApiClient.as('admin');
    branchId = await api.firstBranchId();
    api.withBranch(branchId);
    const res = await api
      .get<{ data?: Candidate[] } | Candidate[]>('/bank-change-requests/migration/candidates')
      .catch(() => null);
    candidates = (Array.isArray(res) ? res : (res?.data ?? [])) ?? [];
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('BMIG-UI-01: the screen loads for an admin and agrees with the API', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, branchId);
      const migrate = new BankMigrationPage(page);
      await migrate.open();

      await expect.poll(() => migrate.count(), { timeout: 20_000 }).toBe(candidates.length);
      settle(problems, 'the bank migration screen');
    });

    test('BMIG-UI-02: every listed candidate carries a legacy bank record', async ({
      page,
      problems,
    }) => {
      test.skip(candidates.length === 0, 'nothing left to migrate');

      await selectBranch(page, branchId);
      const migrate = new BankMigrationPage(page);
      await migrate.open();

      for (const c of candidates) {
        await expect(migrate.row(c.id)).toBeVisible();
        // The list is defined by "ACTIVE, has legacy text, has no active detail".
        expect(c.profile?.bankName ?? '').not.toBe('');
      }
      settle(problems, 'the bank migration list');
    });

    test('BMIG-UI-03: the empty state is shown when nobody is left', async ({ page, problems }) => {
      test.skip(candidates.length > 0, 'candidates remain, so the empty state is not reachable');

      await selectBranch(page, branchId);
      const migrate = new BankMigrationPage(page);
      await migrate.open();

      expect(await migrate.count()).toBe(0);
      await expect(page.getByText(/no employees left to migrate/i)).toBeVisible({
        timeout: 15_000,
      });
      settle(problems, 'the bank migration empty state');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('BMIG-UI-04: HR reaches the screen', async ({ page, problems }) => {
      await page.goto('/dashboard/banks/migrate', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');
      crashesOnly(problems);
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager or employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager') && !isProject('employee'), 'denial projects only');
    });

    test('BMIG-UI-05: a manager and an employee are refused', async ({ page }) => {
      await page.goto('/dashboard/banks/migrate', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
    });
  });
});
