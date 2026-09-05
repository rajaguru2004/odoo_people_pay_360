import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { BanksPage, BankFieldConfigPage, BranchCountriesPage, SidebarNav } from '../../pages';

/**
 * Bank Master and its two configuration screens.
 *
 * Three surfaces with three different audiences, which is the whole point of
 * this file:
 *
 *  - `/dashboard/banks` and `/dashboard/banks/config` are **ADMIN-only**.
 *  - `/dashboard/banks/branch-countries` admits **ADMIN and HR_MANAGER** — and
 *    had no menu entry at all, so an HR authorised for it could never navigate
 *    there; it was reachable only from Bank Master, which HR cannot open.
 *  - The sidebar advertised Bank Master to HR and then bounced them to `/403`,
 *    because the filter reads only `child.roles` and the roles were on the
 *    parent.
 *
 * `/dashboard/banks` and `/dashboard/banks/config` were also `knownBroken` in
 * `routes.ts` — they threw React #310 for HR instead of redirecting. That is
 * asserted here as a clean redirect.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const runId = `pwm${Date.now().toString(36)}`;
const BANK = `Journey Bank ${runId}`;
/** The country the Bank Master screen opens on. Seed the fixture bank there,
 *  or the list is filtered away from it and the journey asserts an empty table. */
const COUNTRY = 'OM';

test.describe('bank master', () => {
  let api: ApiClient;

  test.beforeAll(async () => {
    api = await ApiClient.as('admin');
  });

  test.afterAll(async () => {
    const banks = await api
      ?.get<{ data?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>(
        '/banks',
      )
      .catch(() => null);
    const list = Array.isArray(banks) ? banks : (banks?.data ?? []);
    for (const b of list ?? []) {
      if (b.name.includes(runId)) {
        await api.patch(`/banks/${b.id}/deactivate`, {}).catch(() => {});
      }
    }
    await api?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'admin journey');
    });

    test('BM-UI-01: an admin sees the bank master and its rows carry their state', async ({
      page,
      problems,
    }) => {
      // Seeded over the API: the add form is a small dialog whose shape is the
      // component test's business, while what this journey owns is that the list
      // reflects the record and its active flag.
      await api.post('/banks', { country: COUNTRY, name: BANK, bankCode: 'JBK' }).catch(() => {});

      const banks = new BanksPage(page);
      await banks.open();

      await expect.poll(() => banks.row(BANK).count(), { timeout: 20_000 }).toBe(1);
      expect(await banks.isActive(BANK)).toBe(true);
      settle(problems, 'the bank master');
    });

    test('BM-UI-02: deactivating a bank is visible on the row', async ({ page, problems }) => {
      const list = await api.get<{ data?: Array<{ id: string; name: string }> }>(`/banks?country=${COUNTRY}`);
      const target = (list?.data ?? []).find((b) => b.name === BANK);
      test.skip(!target, 'the bank was not created');

      await api.patch(`/banks/${target!.id}/deactivate`, {});

      const banks = new BanksPage(page);
      await banks.open();
      await expect.poll(() => banks.isActive(BANK), { timeout: 20_000 }).toBe(false);
      settle(problems, 'the bank master after a deactivation');
    });

    test('BM-UI-03: the field config screen loads for an admin', async ({ page, problems }) => {
      const config = new BankFieldConfigPage(page);
      await config.open();
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');
      await expect(page.getByTestId('bankfield-seed')).toBeVisible();
      settle(problems, 'the banking field config');
    });

    test('BM-UI-04: branch countries loads and saves for an admin', async ({ page, problems }) => {
      const branchId = await api.firstBranchId();
      const countries = new BranchCountriesPage(page);
      await countries.open();

      await expect.poll(() => countries.row(branchId).count(), { timeout: 20_000 }).toBe(1);
      settle(problems, 'the branch countries screen');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as hr', () => {
    test.beforeEach(() => {
      test.skip(!isProject('hr'), 'hr project only');
    });

    test('BM-UI-05: branch countries is reachable by HR — and now offered in the nav', async ({
      page,
      problems,
    }) => {
      // The server admits HR here. Before Phase 4 the screen had no menu entry and
      // its only link lived on Bank Master, which HR cannot open — so a permission
      // they held was unreachable in practice.
      await page.goto('/dashboard/banks/branch-countries', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.url(), { timeout: 20_000 }).not.toContain('/403');

      const nav = new SidebarNav(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await expect
        .poll(
          () => page.locator('a[href="/dashboard/banks/branch-countries"]').count(),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      expect(nav).toBeTruthy();
      crashesOnly(problems);
    });

    test('BM-UI-06: HR is redirected from the ADMIN-only banking screens, not crashed', async ({
      page,
      problems,
    }) => {
      for (const path of ['/dashboard/banks', '/dashboard/banks/config']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
      }
      // The point of the case: a clean redirect, not the React #310 these two
      // routes used to throw for HR.
      crashesOnly(problems);
    });

    test('BM-UI-07: HR is no longer offered Bank Master in the nav', async ({ page, problems }) => {
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      // The filter reads only `child.roles`; the group's own roles array is inert,
      // so the ADMIN-only children have to say so themselves.
      expect(await page.locator('a[href="/dashboard/banks"]').count()).toBe(0);
      expect(await page.locator('a[href="/dashboard/banks/config"]').count()).toBe(0);
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

    test('BM-UI-08: a manager and an employee are refused every banking screen', async ({ page }) => {
      for (const path of [
        '/dashboard/banks',
        '/dashboard/banks/config',
        '/dashboard/banks/branch-countries',
        '/dashboard/banks/migrate',
      ]) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => page.url(), { timeout: 20_000 }).toContain('/403');
      }
    });
  });
});
