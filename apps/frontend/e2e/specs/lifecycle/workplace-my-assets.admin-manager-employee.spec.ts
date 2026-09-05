import { Page } from '@playwright/test';
import { test, expect, settle, ApiClient, runId } from '../../fixtures';
import { MyAssetsPage } from '../../pages';

/**
 * "My Assets" — the employee's side of asset custody.
 *
 * This screen is where an employee signs for company property, and where a
 * leaver finds out why their exit is blocked. Two things therefore matter more
 * than anything else on it: the open/past split (an item still out must never
 * be filed under "previously held"), and the acknowledgement, which is the
 * digital receipt the clearance conversation is later held against.
 *
 * Replaces the employee half of `assets.spec.ts`, whose two cases asserted only
 * that the page had a non-empty `<title>`.
 *
 * ## R17 — this page carried no `ProtectedRoute`. Fixed.
 *
 * `/dashboard/my-assets`, `/dashboard/my-letters` and `/dashboard/my-documents`
 * were the only dashboard screens with no client-side guard at all: they
 * rendered their shell for whoever the browser happened to be and relied
 * entirely on the server scoping the payload. Every one of them is now wrapped
 * in `<ProtectedRoute>`, the same component every other dashboard screen uses.
 *
 * The guard is BARE — no `requiredPermission`, no `requiredRoles` — and that is
 * the load-bearing part of the fix, not an omission from it. These are
 * self-service screens: every authenticated role may open them and each one
 * sees only their own records, so what was missing was a settled answer to "is
 * anybody signed in?", not a narrower audience. Narrowing them would take the
 * page away from the people it exists for, and is what `MYA-UI-06` below exists
 * to catch if anyone ever tries.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

interface Assignment {
  id: string;
  assignedAt: string;
  returnedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  asset?: { assetTag: string; name: string };
}

/**
 * Pins the browser's branch before any app code runs.
 *
 * `AssetAssignment` is `relation`-scoped by its holder, so the ESS list is
 * narrowed by `X-Branch-Id` too. The restored sessions arrive with nothing
 * selected and `BranchPicker` then writes `options[0]` — `E2E-BR2`, the branch
 * none of the seeded people are in. Not `selectBranch()` from `e2e/pages`,
 * which navigates via `/dashboard` and would put that screen's console noise in
 * front of the `problems` fixture on a test that never opened it.
 */
async function useBranch(page: Page, branchId: string): Promise<void> {
  await page.addInitScript((id) => {
    window.localStorage.setItem(
      'branch-storage',
      JSON.stringify({ state: { selectedBranchId: id }, version: 0 }),
    );
  }, branchId);
}

let HO_BRANCH = '';

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  HO_BRANCH = await api.firstBranchId();
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await useBranch(page, HO_BRANCH);
});

// ─── The employee's own custody ──────────────────────────────────────────────

test.describe('my assets, as the employee who holds them', () => {
  /** Set up over the API — the ACTIONS under test are the ones clicked below. */
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the holder journey');
  });

  let openId = '';
  let pastId = '';
  let ackId = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;

    const admin = await ApiClient.as('admin');
    const emp = await ApiClient.as('employee');
    const branchId = await admin.firstBranchId();

    const me = await emp.get<Assignment[]>('/assets/my?openOnly=false');
    const seeded = me.find((a) => !a.returnedAt && a.asset?.assetTag === 'E2E-AST-HELD');
    if (!seeded) throw new Error('the baseline seed did not put E2E-AST-HELD out with EMP001');
    openId = seeded.id;

    const directory = await admin.get<Array<{ id: string; employeeCode: string }>>(
      '/employees/directory',
    );
    const holder = directory.find((e) => e.employeeCode === 'EMP001')!;

    // A CLOSED custody period, so the past section has a subject. Built on its
    // own asset rather than by returning the seeded one, which the
    // acknowledgement case still needs open.
    const closedAsset = await admin.post<{ id: string }>('/assets', {
      assetTag: `MYA-${RUN}-P`,
      category: 'E2E Laptop',
      name: `Returned Laptop ${RUN}`,
      branchId,
    });
    const closed = await admin.post<{ id: string }>('/assets/assignments', {
      assetId: closedAsset.id,
      employeeId: holder.id,
      conditionOut: 'Fine',
    });
    pastId = closed.id;
    await admin.post(`/assets/assignments/${closed.id}/return`, {
      conditionIn: 'Returned intact',
      assetStatus: 'AVAILABLE',
    });

    // A second OPEN, unacknowledged custody row dedicated to the acknowledge
    // case. Using a fresh one keeps the case idempotent across retries — the
    // seeded row can only be acknowledged once per database.
    const ackAsset = await admin.post<{ id: string }>('/assets', {
      assetTag: `MYA-${RUN}-A`,
      category: 'E2E Laptop',
      name: `Receipt Laptop ${RUN}`,
      branchId,
    });
    const ack = await admin.post<{ id: string }>('/assets/assignments', {
      assetId: ackAsset.id,
      employeeId: holder.id,
      conditionOut: 'Sealed box',
    });
    ackId = ack.id;

    await admin.dispose();
    await emp.dispose();
  });

  test('MYA-UI-01 open custody and closed custody are shown apart', async ({ page, problems }) => {
    const my = new MyAssetsPage(page);
    await my.open();

    await expect(my.openSection).toBeVisible();
    await expect(my.row(openId)).toBeVisible();
    await expect(my.row(ackId)).toBeVisible();

    // A returned item must not sit in "currently held" — that is the row a
    // leaver and an HR officer read to decide whether the exit is clear.
    await expect(my.pastSection).toBeVisible();
    await expect(my.pastSection.getByTestId(`my-asset-row-${pastId}`)).toBeVisible();
    expect(await my.openSection.getByTestId(`my-asset-row-${pastId}`).count()).toBe(0);

    // A closed period has no receipt to sign, so no control is offered for it.
    expect(await my.ackButton(pastId).count()).toBe(0);
    settle(problems, 'the open/past split on my-assets');
  });

  test('MYA-UI-02 acknowledging through the UI flips the receipt and drops the count', async ({
    page,
    problems,
  }) => {
    const my = new MyAssetsPage(page);
    await my.open();

    /** The banner's figure, or 0 when it has gone away entirely. */
    const bannerCount = async () =>
      (await my.unacknowledged.count()) === 0 ? 0 : await my.unacknowledgedCount();
    /** Rows still showing an unsigned receipt. */
    const unsignedRows = () =>
      page.locator('[data-testid^="my-asset-ack-state-"][data-acknowledged="false"]').count();

    expect(await my.isAcknowledged(ackId)).toBe(false);
    const before = await bannerCount();
    expect(before).toBeGreaterThan(0);
    // The amber banner is the only prompt an employee gets, so what it counts
    // has to be what is on the screen. Asserted as an invariant rather than a
    // delta: the admin project hands this same person another asset while this
    // runs, and a row arriving between two reads is the harness moving.
    expect(before).toBe(await unsignedRows());

    /** Rows carrying a signed receipt. This set only ever grows. */
    const signedRows = () =>
      page.locator('[data-testid^="my-asset-ack-state-"][data-acknowledged="true"]').count();
    const signedBefore = await signedRows();

    const note = `Received in good order ${RUN}`;
    await my.acknowledge(ackId, note);

    await expect
      .poll(() => my.isAcknowledged(ackId), { timeout: 15_000 })
      .toBe(true);
    // One more signed receipt than before — monotone, so a concurrent handover
    // cannot make a working screen look broken.
    await expect.poll(signedRows, { timeout: 15_000 }).toBeGreaterThan(signedBefore);
    // And the banner still counts exactly the rows that are still unsigned,
    // which is the half a stale prompt would break.
    expect(await bannerCount()).toBe(await unsignedRows());

    // Re-read over the API: the screen must have recorded a receipt, not just
    // repainted a badge.
    const emp = await ApiClient.as('employee');
    const rows = await emp.get<Assignment[]>('/assets/my?openOnly=false');
    const row = rows.find((r) => r.id === ackId)!;
    expect(row.acknowledgedAt).toBeTruthy();
    expect(row.acknowledgedNote).toBe(note);
    await emp.dispose();
    settle(problems, 'acknowledging receipt of an asset');
  });

  test('MYA-UI-03 a second acknowledgement is not offered', async ({ page, problems }) => {
    const my = new MyAssetsPage(page);
    await my.open();

    expect(await my.isAcknowledged(ackId)).toBe(true);
    // `acknowledge()` is holder-only, once-only and open-only on the server.
    // The screen must not invite a call it knows will be refused.
    expect(await my.ackButton(ackId).count()).toBe(0);
    expect(await my.ackConfirm(ackId).count()).toBe(0);
    settle(problems, 'an already-acknowledged row');
  });

  test("MYA-UI-04 the list is the employee's own, and nobody else's", async ({
    page,
    problems,
  }) => {
    const my = new MyAssetsPage(page);
    await my.open();

    // The baseline puts E2E-AST-BR2-HELD out with EMP002. `GET /assets/my` is
    // keyed on the caller's own employee id and the screen has no filter of its
    // own, so this is the one place that proves the scoping is the server's
    // rather than the page's.
    const emp = await ApiClient.as('employee');
    const mine = await emp.get<Assignment[]>('/assets/my?openOnly=false');
    await emp.dispose();

    expect(mine.some((r) => r.asset?.assetTag === 'E2E-AST-HELD')).toBe(true);
    expect(mine.some((r) => r.asset?.assetTag === 'E2E-AST-BR2-HELD')).toBe(false);

    // Every row on the screen belongs to this employee — asserted as
    // containment rather than an exact count, because the admin project assigns
    // to this same person while this runs and a custody row created between the
    // page load and the read above is the harness moving, not the screen
    // dropping anything. Containment is the claim that matters: the page must
    // never show a row that is not the caller's.
    const ids = await page
      .locator('[data-testid^="my-asset-row-"]')
      .evaluateAll((els) =>
        els.map((el) => (el.getAttribute('data-testid') ?? '').replace('my-asset-row-', '')),
      );
    expect(ids.length).toBeGreaterThan(0);
    const owned = new Set(mine.map((r) => r.id));
    for (const id of ids) expect(owned.has(id), `row ${id} is not this employee's`).toBe(true);

    // And the two rows this case exists for are among them.
    await expect(my.row(openId)).toBeVisible();
    await expect(my.row(pastId)).toBeVisible();
    settle(problems, 'my-assets scoping');
  });
});

// ─── R17: the page every role renders ────────────────────────────────────────

test.describe('my assets, as a role that holds nothing', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the unguarded-page pass');
    });

    test('MYA-UI-05 an admin holding nothing gets the empty state, not a crash', async ({
      page,
      problems,
    }) => {
      const my = new MyAssetsPage(page);
      await my.open();

      // ADM001 has never been handed anything. The empty state has to SAY so —
      // a blank section is indistinguishable from a request that failed.
      await expect(my.openSection).toBeVisible();
      await expect(my.empty).toBeVisible();
      expect(await page.locator('[data-testid^="my-asset-row-"]').count()).toBe(0);
      settle(problems, 'my-assets with nothing held');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the ESS-guard pass');
    });

    test('MYA-UI-06 R17: the guard authenticates and does not narrow — a MANAGER still gets in', async ({
      page,
      problems,
    }) => {
      /**
       * R17, fixed — and this is the case that keeps the fix honest.
       *
       * `app/dashboard/my-assets/page.tsx` used to export its component directly:
       * no `<ProtectedRoute>` anywhere, while its administrative sibling
       * `/dashboard/assets` sends an EMPLOYEE to `/403` in this same run
       * (AST-UI-20). The page is wrapped now, with a BARE guard.
       *
       * The obvious mistake when closing a finding worded "this page is
       * unguarded" is to reach for `requiredRoles` and hand an ESS screen to
       * administrators only. A MANAGER is exactly the principal that would be
       * lost: they hold no `VIEW_ASSETS`-shaped power, and they are still
       * entitled to see what THEY are holding. So the assertion is that they
       * arrive, on the page and not on /403 — the guard decides whether anyone is
       * signed in, and the server decides what they see.
       *
       * `e2e/routes.ts` records the route as `allowed: EVERYONE`, which is the
       * same statement made by the independent oracle.
       */
      const my = new MyAssetsPage(page);
      await my.open();

      const landed = new URL(page.url()).pathname;
      expect(landed, 'the ESS guard narrowed a self-service screen by role').not.toBe('/403');
      expect(landed).toBe('/dashboard/my-assets');

      // Rendered, not merely not-redirected: `ProtectedRoute` paints nothing
      // until the session has settled, so a page that renders is a page whose
      // guard reached a verdict.
      await expect(my.openSection).toBeVisible();
      // MGR001 holds nothing, so the manager sees an empty list — the server, not
      // the page, is what makes that safe, and that division is unchanged.
      await expect(my.empty).toBeVisible();
      settle(problems, 'my-assets as a manager');
    });
  });
});
