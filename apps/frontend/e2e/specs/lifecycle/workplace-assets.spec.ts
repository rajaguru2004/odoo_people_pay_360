import { Page } from '@playwright/test';
import { test, expect, settle, crashesOnly, ApiClient, runId } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { AssetsPage, AssetAssignDialog, AssetReturnDialog } from '../../pages';

/**
 * The Asset Register, from the screen that runs it.
 *
 * Replaces `assets.spec.ts`, which set every piece of state over the API and
 * then asserted only that the page had not crashed. The three genuine
 * assertions in that file — a created asset appears in the list, an EMPLOYEE is
 * refused `GET /assets`, and an EMPLOYEE is redirected away from
 * `/dashboard/assets` — are carried across; everything else is driven through
 * the real form, the real modal and the real confirm dialog, and then re-read
 * over the API so a screen that only updated its own state cannot pass.
 *
 * What is worth catching here is not "the button did not submit". It is an
 * asset that says AVAILABLE while somebody is still carrying it — the register
 * is the evidence behind an offboarding clearance, and a wrong row in it lets
 * someone leave with a laptop.
 *
 * ## Concurrency note
 *
 * The four role projects share one database and can run at the same time, so
 * every counter assertion here is a DIRECTION (`toBeGreaterThan` /
 * `toBeLessThan`) rather than an exact delta, except in AST-UI-01 which
 * compares the tiles against the very payload that page load received. A
 * concurrent write in another project moves a counter; it cannot reverse the
 * direction of this one's own action.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * Unique per worker AND per run, so two role projects cannot collide on a tag —
 * `assetTag` is globally unique, and a collision would read as a product defect.
 *
 * Computed at module load rather than from `test.info()`, because the describe
 * bodies below need a stable tag before any test starts running.
 */
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const tag = (suffix: string) => `AST-${RUN}-${suffix}`;

const CATEGORY = 'E2E Laptop';
const BRANCH = 'Head Office';

interface AssetRow {
  id: string;
  assetTag: string;
  name: string;
  status: string;
  serialNumber: string | null;
  branchId: string;
  currentHolder: { assignmentId: string; employee: { employeeCode: string } } | null;
}

/**
 * Records every toast the page shows, and pins the branch — both installed
 * before any app code runs.
 *
 * ## Why the toasts are captured rather than queried
 *
 * These screens report every outcome through `sonner`, which auto-dismisses
 * after about four seconds. A spec that clicks, waits for the network to
 * settle and only then looks for the message loses that race intermittently and
 * reports "the user was told nothing" for a screen that told them perfectly
 * well. Recording each toast as it is inserted makes the assertion independent
 * of when it is made.
 *
 * `sonner` is also NOT the container `ToastArea` in `e2e/pages` was written for
 * — that one reads the app's own `lib/toast.tsx`. Keeping the two apart is
 * deliberate: the point of these cases is what this screen actually ships.
 *
 * ## Why the branch is pinned
 *
 * Assets are `direct`-scoped and letter requests `relation`-scoped, so both
 * lists are narrowed by the `X-Branch-Id` the axios interceptor reads out of
 * `branch-storage`. The restored sessions in `.auth/` arrive with nothing
 * selected, and `BranchPicker` then writes `options[0]` on mount — `E2E-BR2`,
 * alphabetically first and the branch none of the seeded fixtures live in.
 * Left alone that gives an empty queue and tiles that disagree with the payload
 * the page just received.
 *
 * Deliberately not `selectBranch()` from `e2e/pages`: that helper navigates via
 * `/dashboard` to make the write stick, and the dashboard's own console noise
 * for a MANAGER or an EMPLOYEE would then be judged by the `problems` fixture
 * on a test that never opened it.
 */
interface CapturedToast {
  type: string;
  text: string;
}

async function primePage(page: Page, branchId: string): Promise<void> {
  await page.addInitScript((id: string) => {
    window.localStorage.setItem(
      'branch-storage',
      JSON.stringify({ state: { selectedBranchId: id }, version: 0 }),
    );

    const store: CapturedToast[] = [];
    (window as unknown as { __toasts: CapturedToast[] }).__toasts = store;
    const seen = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll('[data-sonner-toast]').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        // One frame later, so React has committed the toast's children.
        requestAnimationFrame(() =>
          store.push({
            type: el.getAttribute('data-type') ?? '',
            text: (el as HTMLElement).innerText || el.textContent || '',
          }),
        );
      });
    };
    // `document`, not `document.documentElement`: this script runs at document
    // start, where the root element does not exist yet.
    new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  }, branchId);
}

/** Everything this page has said, newest last. */
async function toastTexts(page: Page, type?: string): Promise<string> {
  const all = await page.evaluate(
    () => (window as unknown as { __toasts?: CapturedToast[] }).__toasts ?? [],
  );
  return all
    .filter((t) => !type || t.type === type)
    .map((t) => t.text)
    .join(' | ');
}

async function expectToast(page: Page, re: RegExp, type?: string): Promise<void> {
  await expect
    .poll(() => toastTexts(page, type), {
      timeout: 12_000,
      message: `no ${type ?? 'any'} toast matching ${re}`,
    })
    .toMatch(re);
}

/**
 * The app's GLOBAL 403 handler, which is a modal rather than a message.
 *
 * `lib/axios.ts` calls `triggerPermissionError()` on every 403, from an
 * interceptor that runs before any caller's own `catch` — so a screen that
 * deliberately swallows a refusal still used to get a `fixed inset-0 z-[9999]`
 * "Access Denied" dialog over the whole page (R75). It is asserted ABSENT here
 * rather than dismissed: the register never provokes a 403 any more, because
 * the summary is not requested by a role that may not read it. The dialog
 * itself is unchanged and still fires on a genuine denial.
 */
function permissionModal(page: Page) {
  return page.getByTestId('permission-denied-modal');
}

/** Every POST the page fired, so "the client refused" can be told from "the server did". */
function recordPosts(page: Page, fragment: string): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(fragment)) seen.push(r.url());
  });
  return seen;
}

async function assetByTag(api: ApiClient, assetTag: string): Promise<AssetRow | undefined> {
  const rows = await api.get<AssetRow[]>(`/assets?search=${encodeURIComponent(assetTag)}`);
  return (Array.isArray(rows) ? rows : []).find((r) => r.assetTag === assetTag);
}

/** HO — the branch every seeded workplace fixture lives in. */
let HO_BRANCH = '';

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  HO_BRANCH = await api.firstBranchId();
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await primePage(page, HO_BRANCH);
});

// ─── The register, as an ADMIN runs it ───────────────────────────────────────

test.describe('the asset register, as an admin runs it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the register is an administrative screen');
  });

  const created = tag('A');
  const serial = `SN-${created}`;
  let holderId = '';
  let holderCode = '';
  // The holder's name, because R76's on-screen refusal names the person and a
  // hard-coded name would go stale the first time the seed changed.
  let holderName = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    const api = await ApiClient.as('admin');
    const emps = await api.get<Array<{ id: string; employeeCode: string; fullName: string; status?: string }>>(
      '/employees/directory',
    );
    const emp = emps.find((e) => e.employeeCode === 'EMP001') ?? emps[0];
    holderId = emp.id;
    holderCode = emp.employeeCode;
    holderName = emp.fullName;
    await api.dispose();
  });

  test('AST-UI-01 the tiles publish the figures the summary endpoint returned', async ({
    page,
    problems,
  }) => {
    // The payload THIS page load received, not a second read of our own: the
    // four projects share one database, so an asset created by another project
    // between two reads would make a correct screen look wrong. The LAST one,
    // because the picker settling its branch can produce a second fetch and the
    // tiles render whichever answered last.
    interface Summary {
      total: number;
      held: number;
      unacknowledged: number;
      byStatus: Record<string, number>;
    }
    const payloads: Summary[] = [];
    page.on('response', async (r) => {
      if (r.request().method() !== 'GET') return;
      if (!r.url().startsWith(`${API_URL}/assets/summary`)) return;
      const body = await r.json().catch(() => null);
      if (body?.data) payloads.push(body.data as Summary);
    });

    const assets = new AssetsPage(page);
    await assets.open();
    await expect.poll(() => payloads.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const summary = payloads[payloads.length - 1];

    // The tiles are the first thing anyone reads on this screen and they are
    // computed client-side from this one payload. A disagreement means the
    // summary is lying about the estate.
    expect(await assets.statValue('total')).toBe(summary.total);
    expect(await assets.statValue('held')).toBe(summary.held);
    expect(await assets.statValue('available')).toBe(summary.byStatus.AVAILABLE ?? 0);
    expect(await assets.statValue('unacknowledged')).toBe(summary.unacknowledged);

    // The baseline pair, so a later "the row is gone" assertion means something.
    await expect(assets.row('E2E-AST-FREE')).toBeVisible();
    await expect(assets.row('E2E-AST-HELD')).toBeVisible();
    settle(problems, 'the asset register');
  });

  test('AST-UI-02 a new asset is created through the form and the register agrees', async ({
    page,
    problems,
    api,
  }) => {
    const assets = new AssetsPage(page);
    await assets.open();
    const beforeTotal = await assets.statValue('total');
    const beforeAvailable = await assets.statValue('available');

    await assets.create({
      tag: created,
      name: `Journey Laptop ${created}`,
      category: CATEGORY,
      branch: BRANCH,
      serial,
    });

    await expect(assets.row(created)).toBeVisible({ timeout: 15_000 });
    expect(await assets.rowStatus(created).innerText()).toContain('AVAILABLE');

    // Direction, not delta — see the concurrency note at the top of the file.
    await expect
      .poll(() => assets.statValue('total'), { timeout: 15_000 })
      .toBeGreaterThan(beforeTotal);
    await expect
      .poll(() => assets.statValue('available'), { timeout: 15_000 })
      .toBeGreaterThan(beforeAvailable);

    // Re-read over the API: the screen must have persisted what it displayed,
    // not merely rendered the object it posted.
    const row = await assetByTag(api, created);
    expect(row, 'the asset the form created is not in the API list').toBeTruthy();
    expect(row!.status).toBe('AVAILABLE');
    expect(row!.serialNumber).toBe(serial);
    expect(row!.name).toBe(`Journey Laptop ${created}`);
    expect(row!.currentHolder).toBeNull();
    settle(problems, 'creating an asset through the form');
  });

  test("AST-UI-03 R73: a duplicate tag creates nothing, and says which tag collided", async ({
    page,
    problems,
    api,
  }) => {
    // The 409 is the point of the case, and the browser logs every non-2xx as a
    // console error — so only a crash can fail this one.
    crashesOnly(problems);

    const assets = new AssetsPage(page);
    await assets.open();

    await assets.create({
      tag: created,
      name: 'Second laptop with the same tag',
      category: CATEGORY,
      branch: BRANCH,
    });

    /**
     * R73 — FIXED, and this is the case that proves it end to end.
     *
     * `assetTag` is globally unique, and the service maps the P2002 to a 409
     * whose body reads `Asset tag "X" is already in use` — the one sentence an
     * operator needs, because it names the value to change.
     *
     * The user never saw it. `lib/axios.ts` REJECTS WITH A FLAT OBJECT rather
     * than the AxiosError, so there is no `.response` on what the caller
     * catches; every handler on these screens read `e?.response?.data?.message`,
     * got `undefined`, and fell through to its own generic string. The
     * interceptor's flat shape is relied on across the whole app and is pinned
     * by `lib/axios.test.ts`, so the fix went the other way: the workplace
     * screens now call `apiErrorMessage()` from `utils/apiError.ts`, which
     * reads both shapes.
     *
     * The assertion is deliberately on the VALUE as well as the sentence. A
     * message that says "already in use" without naming the tag is the same
     * dead end one sentence later.
     */
    await expectToast(page, /already in use/i, 'error');
    expect(await toastTexts(page, 'error')).toContain(created);

    // The important half regardless: nothing was created.
    const rows = await api.get<AssetRow[]>(`/assets?search=${encodeURIComponent(created)}`);
    expect(rows.filter((r) => r.assetTag === created)).toHaveLength(1);
    settle(problems, 'a duplicate asset tag');
  });

  test('AST-UI-05 the form refuses to submit with tag, name, category or branch missing', async ({
    page,
    problems,
  }) => {
    const posts = recordPosts(page, '/assets');
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.newButton.click();

    const full = {
      tag: tag('V'),
      name: 'Validation probe',
      category: CATEGORY,
      branch: BRANCH,
    };

    const fill = async (omit: 'tag' | 'name' | 'category' | 'branch') => {
      await assets.formTag.fill(omit === 'tag' ? '' : full.tag);
      await assets.formName.fill(omit === 'name' ? '' : full.name);
      await assets.formCategory.selectOption(omit === 'category' ? '' : { label: full.category });
      await assets.formBranch.selectOption(omit === 'branch' ? '' : { label: full.branch });
    };

    for (const omit of ['tag', 'name', 'category', 'branch'] as const) {
      await fill(omit);
      await assets.formSubmit.click();
      // The client names all four in one sentence. What matters is that it
      // refuses locally: a blank tag reaching the server comes back as a
      // validation error the user cannot map onto a field.
      await expectToast(page, /Tag, name, category and branch are required/i, 'warning');
      expect(posts, `submitting with ${omit} missing sent a request`).toHaveLength(0);
    }

    // And the same four fields, all present, do submit — otherwise the loop
    // above would pass on a form that is simply broken.
    await assets.formTag.fill(full.tag);
    await assets.formName.fill(full.name);
    await assets.formCategory.selectOption({ label: full.category });
    await assets.formBranch.selectOption({ label: full.branch });
    await assets.formSubmit.click();
    await expect(assets.row(full.tag)).toBeVisible({ timeout: 15_000 });
    expect(posts.length).toBe(1);
    settle(problems, 'the create form validation');
  });

  test('AST-UI-06 search finds an asset by tag, by name and by serial', async ({
    page,
    problems,
  }) => {
    const assets = new AssetsPage(page);
    await assets.open();

    await assets.search.fill(created);
    await expect(assets.row(created)).toBeVisible();
    await expect(assets.row('E2E-AST-FREE')).toBeHidden();

    await assets.search.fill(`Journey Laptop ${created}`);
    await expect(assets.row(created)).toBeVisible();

    // The serial is the only one of the three a user searches by when the tag
    // sticker has come off, and it is the field most likely to be dropped from
    // a `search` clause without anyone noticing.
    await assets.search.fill(serial);
    await expect(assets.row(created)).toBeVisible();
    await expect(assets.row('E2E-AST-FREE')).toBeHidden();
    settle(problems, 'searching the register');
  });

  test('AST-UI-07 the status filter narrows the list', async ({ page, problems }) => {
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill('E2E-AST-');

    await assets.statusFilter.selectOption('ASSIGNED');
    await expect(assets.row('E2E-AST-HELD')).toBeVisible();
    await expect(assets.row('E2E-AST-FREE')).toBeHidden();

    await assets.statusFilter.selectOption('AVAILABLE');
    await expect(assets.row('E2E-AST-FREE')).toBeVisible();
    await expect(assets.row('E2E-AST-HELD')).toBeHidden();

    await assets.statusFilter.selectOption('');
    await expect(assets.row('E2E-AST-FREE')).toBeVisible();
    await expect(assets.row('E2E-AST-HELD')).toBeVisible();
    settle(problems, 'the status filter');
  });

  test('AST-UI-08 a filter matching nothing shows the empty state', async ({ page, problems }) => {
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill(`no-such-asset-${runId}`);

    await expect(assets.empty).toBeVisible();
    // An empty result must SAY so. A blank table is indistinguishable from a
    // request that failed, which is how "the list is broken" gets reported.
    expect(await page.locator('[data-testid^="asset-row-"]').count()).toBe(0);
    settle(problems, 'an empty register result');
  });

  test('AST-UI-09 assigning through the modal moves the asset, the tiles and the API', async ({
    page,
    problems,
    api,
  }) => {
    const assets = new AssetsPage(page);
    const assign = new AssetAssignDialog(page);
    await assets.open();
    await assets.search.fill(created);
    await expect(assets.row(created)).toBeVisible();

    const beforeHeld = await assets.statValue('held');
    const beforeAvailable = await assets.statValue('available');

    await assets.assignButton(created).click();
    await expect(assign.root).toBeVisible();
    // Selected by VALUE, not label: the option text is `${fullName} (${code})`
    // and a spec that encodes a person's name breaks when the seed renames them.
    await assign.employee.selectOption(holderId);
    await assign.condition.fill('Boxed, no marks');
    await assign.submit.click();

    await expect(assign.root).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(() => assets.rowStatus(created).innerText(), { timeout: 15_000 })
      .toContain('ASSIGNED');

    await expect
      .poll(() => assets.statValue('held'), { timeout: 15_000 })
      .toBeGreaterThan(beforeHeld);
    await expect
      .poll(() => assets.statValue('available'), { timeout: 15_000 })
      .toBeLessThan(beforeAvailable);
    // A brand-new assignment is unacknowledged by construction, so the tile HR
    // watches for "who has not signed for their kit" must be non-zero.
    expect(await assets.statValue('unacknowledged')).toBeGreaterThan(0);

    const row = await assetByTag(api, created);
    expect(row!.status).toBe('ASSIGNED');
    expect(row!.currentHolder).toBeTruthy();
    expect(row!.currentHolder!.employee.employeeCode).toBe(holderCode);

    // The custody row itself, not just the asset's status column — the
    // clearance gate keys on `returnedAt IS NULL`, never on `AssetItem.status`.
    const open = await api.get<Array<{ asset?: { assetTag: string }; conditionOut: string | null }>>(
      `/assets/assignments/open?employeeId=${holderId}`,
    );
    const mine = open.find((a) => a.asset?.assetTag === created);
    expect(mine, 'the assignment the modal created is not an open custody row').toBeTruthy();
    expect(mine!.conditionOut).toBe('Boxed, no marks');
    settle(problems, 'assigning an asset through the modal');
  });

  test('AST-UI-10 R76: a held asset offers no assign, and says on screen why it cannot be deleted', async ({
    page,
    problems,
  }) => {
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill(created);
    await expect(assets.row(created)).toBeVisible();

    // While the asset is out, the row swaps Assign for Return outright.
    await expect(assets.returnButton(created)).toBeVisible();
    expect(await assets.assignButton(created).count()).toBe(0);

    await expect(assets.deleteButton(created)).toBeDisabled();

    /**
     * R76, fixed. The refusal used to live in a native `title` on the disabled
     * button and nowhere else, so the server's own reason — "This asset is
     * currently held by an employee. Record its return before deleting it."
     * (AST-API-19) — never rendered. A tooltip is mouse-only: a disabled button
     * cannot be focused, so a keyboard user could not summon it, and a touch
     * user has no hover at all. The explanation was unreachable for both.
     *
     * It is now written into the row, and `aria-describedby` ties it to the
     * control it is about.
     */
    const reason = page.getByTestId(`asset-delete-reason-${created}`);
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/record its return before deleting it/i);
    // The person, not just the rule — "who has it" is the next question the
    // reason has to answer, and it is the one the register exists for.
    await expect(reason).toContainText(holderName);
    expect(await assets.deleteButton(created).getAttribute('aria-describedby')).toBe(
      `asset-delete-reason-${created}`,
    );

    settle(problems, 'a held asset row');
  });

  test('AST-UI-11 returning as LOST leaves the asset LOST, not AVAILABLE', async ({
    page,
    problems,
    api,
  }) => {
    const assets = new AssetsPage(page);
    const ret = new AssetReturnDialog(page);
    await assets.open();
    await assets.search.fill(created);
    await expect(assets.row(created)).toBeVisible();

    await assets.returnButton(created).click();
    await expect(ret.root).toBeVisible();
    // The dialog defaults to AVAILABLE. A damaged or missing item routed back
    // to AVAILABLE is the shape of a real past defect: the register then offers
    // a laptop that nobody has.
    expect(await ret.status.inputValue()).toBe('AVAILABLE');
    await ret.condition.fill('Not returned — reported lost');
    await ret.status.selectOption('LOST');
    await ret.submit.click();

    await expect(ret.root).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(() => assets.rowStatus(created).innerText(), { timeout: 15_000 })
      .toContain('LOST');

    const row = await assetByTag(api, created);
    expect(row!.status).toBe('LOST');
    expect(row!.status).not.toBe('AVAILABLE');
    expect(row!.currentHolder).toBeNull();
    settle(problems, 'returning an asset as LOST');
  });

  test('AST-UI-12 R2/R76 — a RETIRED asset is unheld, unassignable, and says so on screen', async ({
    page,
    problems,
    api,
  }) => {
    // Prerequisite over the API: an asset that has been through custody and
    // come back RETIRED. The action under test is what the SCREEN offers next.
    const retired = tag('R');
    const branchId = await api.firstBranchId();
    const asset = await api.post<{ id: string }>('/assets', {
      assetTag: retired,
      category: CATEGORY,
      name: `Retired ${retired}`,
      branchId,
    });
    const assignment = await api.post<{ id: string }>('/assets/assignments', {
      assetId: asset.id,
      employeeId: holderId,
    });
    await api.post(`/assets/assignments/${assignment.id}/return`, {
      conditionIn: 'End of life',
      assetStatus: 'RETIRED',
    });

    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill(retired);
    await expect(assets.row(retired)).toBeVisible();
    expect(await assets.rowStatus(retired).innerText()).toContain('RETIRED');

    /**
     * R2 / AST-API-50, the browser half — still open at the API.
     *
     * `unassignedOnly` on `GET /assets` is implemented as "nobody currently
     * holds it", which is NOT the same question as "may it be handed out" —
     * `ASSIGNABLE_STATUSES` is `{AVAILABLE}` alone. So a RETIRED or LOST asset
     * is returned by the picker query while the assign that follows is refused
     * with a 400. Nothing stops the next consumer of `unassignedOnly` (the flag
     * has no caller in the frontend today, `types/asset.ts:124`) from building
     * a picker with no such guard. That half is unchanged and stays recorded.
     *
     * R76, fixed, is the register's half. The row still offers the Assign
     * control — the asset has no holder, so the control belongs to it — and the
     * control still refuses. What changed is that the refusal is now a sentence
     * on the screen rather than a native `title` on a `disabled` button, which
     * no keyboard or touch user could ever reach.
     */
    await expect(assets.assignButton(retired)).toBeVisible();
    await expect(assets.assignButton(retired)).toBeDisabled();

    const reason = page.getByTestId(`asset-assign-reason-${retired}`);
    await expect(reason).toBeVisible();
    // The status it is in, and the status it would have to be in — a reason
    // that names neither is not a reason.
    await expect(reason).toContainText(/RETIRED/);
    await expect(reason).toContainText(/AVAILABLE/);
    expect(await assets.assignButton(retired).getAttribute('aria-describedby')).toBe(
      `asset-assign-reason-${retired}`,
    );

    // And the server agrees it would refuse, which is what makes the client
    // guard load-bearing rather than cosmetic.
    await expect(
      api.post('/assets/assignments', { assetId: asset.id, employeeId: holderId }),
    ).rejects.toThrow(/400/);
    settle(problems, 'a RETIRED asset on the register');
  });

  test('AST-UI-13 R3: an asset with custody history is refused, and says why', async ({
    page,
    problems,
    api,
  }) => {
    // REGRESSION LOCK (R3, fixed). `asset_assignments.asset_id` is
    // `onDelete: Cascade`, and `remove()` used to block only on an OPEN
    // assignment — so deleting a RETURNED asset silently erased its whole
    // custody trail, including the acknowledgement that proved receipt and the
    // return that cleared an offboarding. This asset was assigned in AST-UI-09
    // and returned LOST in AST-UI-11, so it carries exactly that history.
    //
    // The refusal reaching the SCREEN is the other half: before R73 the server's
    // sentence never arrived and the user got "Failed to delete".
    // The 400 is the point of the case, and the browser logs every non-2xx as a
    // console error — so only a crash can fail this one, exactly as AST-UI-03.
    crashesOnly(problems);

    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill(created);
    await expect(assets.row(created)).toBeVisible();

    // The control is live — the asset is unheld. The refusal is the server's.
    await expect(assets.deleteButton(created)).toBeEnabled();
    await assets.deleteButton(created).click();

    const confirm = page.getByTestId('confirm-modal-confirm');
    await confirm.waitFor({ state: 'visible', timeout: 10_000 });
    await confirm.click();

    await expectToast(page, /custody record/i, 'error');
    expect(await toastTexts(page, 'error')).toContain('Retire it instead');

    // Refused means untouched, not half-deleted.
    await expect(assets.row(created)).toBeVisible();
    expect(await assetByTag(api, created)).toBeDefined();
  });

  test('AST-UI-13b an asset that was never assigned still deletes', async ({
    page,
    problems,
    api,
  }) => {
    // The control R3 must not have swallowed: refusing a delete is only correct
    // if the case with nothing to protect still works. A never-assigned asset
    // has no history to erase, so it goes.
    const fresh = tag('DEL');
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.create({
      tag: fresh,
      name: `Deletable Laptop ${fresh}`,
      category: CATEGORY,
      branch: BRANCH,
    });
    await expect(assets.row(fresh)).toBeVisible({ timeout: 15_000 });

    await assets.search.fill(fresh);
    await expect(assets.deleteButton(fresh)).toBeEnabled();
    await assets.deleteButton(fresh).click();

    const confirm = page.getByTestId('confirm-modal-confirm');
    await confirm.waitFor({ state: 'visible', timeout: 10_000 });
    await confirm.click();

    await expect(assets.row(fresh)).toBeHidden({ timeout: 15_000 });
    expect(await assetByTag(api, fresh)).toBeUndefined();
    settle(problems, 'deleting an asset with no custody history');
  });
});

// ─── The same screen, as HR ──────────────────────────────────────────────────

test.describe('the asset register, as HR runs it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR pass over the register');
  });

  const hrTag = tag('H');

  test('AST-UI-14 HR creates an asset through the same form', async ({ page, problems, api }) => {
    const assets = new AssetsPage(page);
    await assets.open();
    await assets.create({
      tag: hrTag,
      name: `HR Laptop ${hrTag}`,
      category: CATEGORY,
      branch: BRANCH,
    });

    await expect(assets.row(hrTag)).toBeVisible({ timeout: 15_000 });
    const row = await assetByTag(api, hrTag);
    expect(row!.status).toBe('AVAILABLE');
    settle(problems, 'HR creating an asset');
  });

  test('AST-UI-15 R74: HR is offered no Delete control, and the server admits ADMIN alone', async ({
    page,
    problems,
    api,
  }) => {
    /**
     * R74 — FIXED. Plan §6.1: "Asset delete: ADMIN 200, HR **403**".
     *
     * `DELETE /assets/:id` carries `@Roles('ADMIN')` while every OTHER write on
     * this screen admits HR, and the screen had no role projection of any kind
     * — so an HR_MANAGER got an enabled red Delete button on every unheld row
     * and found out it was not theirs only after committing to the action, in
     * the framework's own "Forbidden resource", which names nothing.
     *
     * The projection is per-capability rather than per-screen, which is the
     * point: HR keeps create, assign and return here, and loses only the one
     * verb the server reserves. Both halves are asserted, because a client that
     * hides the button while the API stays open is a different bug wearing the
     * same clothes.
     */
    crashesOnly(problems);

    const assets = new AssetsPage(page);
    await assets.open();
    await assets.search.fill(hrTag);
    await expect(assets.row(hrTag)).toBeVisible();

    // The control a caller may not use is not drawn.
    expect(await assets.deleteButton(hrTag).count()).toBe(0);
    // …and the ones they may still are.
    await expect(assets.newButton).toBeVisible();
    await expect(assets.assignButton(hrTag)).toBeVisible();

    // The server's half, unchanged and still the real gate. The `api` fixture
    // is an ADMIN client whatever project is running, so the refusal has to be
    // driven from a client that really is HR — asking the admin one would
    // delete the asset and prove nothing.
    const row = await assetByTag(api, hrTag);
    expect(row).toBeTruthy();
    const hr = await ApiClient.as('hr');
    await expect(hr.delete(`/assets/${row!.id}`)).rejects.toThrow(/403/);
    await hr.dispose();
    expect(await assetByTag(api, hrTag), 'the refused delete left the row alone').toBeTruthy();
    settle(problems, "HR's absent delete control");
  });

  test.afterAll(async () => {
    if (!isProject('hr')) return;
    // ADMIN is the only role that can clear it up — which is the finding.
    const admin = await ApiClient.as('admin');
    const row = await assetByTag(admin, hrTag);
    if (row) await admin.delete(`/assets/${row.id}`);
    await admin.dispose();
  });
});

// ─── Role projection ─────────────────────────────────────────────────────────

test.describe('the asset register, as a manager and as an employee', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager projection');
    });

    test('AST-UI-17 R75: a MANAGER reaches the register, reads it, and is not blocked by a dialog', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);

      const assets = new AssetsPage(page);
      await assets.open();

      // Past the client guard (`requiredRoles` includes MANAGER) and the list
      // itself loads — `GET /assets` admits MANAGER.
      expect(new URL(page.url()).pathname).toBe('/dashboard/assets');
      await expect(assets.row('E2E-AST-FREE')).toBeVisible();
      await expect(assets.row('E2E-AST-HELD')).toBeVisible();

      /**
       * R75 — FIXED.
       *
       * `GET /assets/summary` is ADMIN/HR only. `loadSummary()` had always caught
       * its own 403 so a decorative failure could not blank the table — but
       * `lib/axios.ts` fires `triggerPermissionError()` from the response
       * interceptor, which runs before any caller sees the rejection and knows
       * nothing about the caller's intent. The manager therefore landed on a
       * screen they ARE entitled to, list correctly loaded, underneath a
       * `fixed inset-0 z-[9999]` "Access Denied" dialog raised by a tile query —
       * modal, pointer-event-eating, and unrelated to anything they had done.
       *
       * Fixed by not asking a question this role may not ask: the page reads its
       * own role and skips the summary entirely. The modal itself is untouched,
       * because a GENUINE denial still has to raise it — asserted in AST-UI-20,
       * where a manager's refused write does exactly that.
       *
       * So: the four tiles are simply absent rather than wrong, and the screen is
       * usable from the moment it loads.
       */
      expect(await assets.stat('total').count()).toBe(0);
      await expect(permissionModal(page)).toHaveCount(0);

      // Usable, not merely visible: the modal used to intercept every click.
      await assets.search.fill('E2E-AST-');
      await expect(assets.row('E2E-AST-FREE')).toBeVisible();
      settle(problems, 'the register as a manager');
    });

    test('AST-UI-18 R74: a MANAGER is offered no write control at all', async ({
      page,
      problems,
    }) => {
      /**
       * R74 — FIXED. Plan §6.1 and §6.3: a MANAGER gets "list + read, no
       * create/assign/delete controls".
       *
       * `app/dashboard/assets/page.tsx` contained no role check of any kind:
       * `asset-new`, `asset-assign-*`, `asset-return-*` and `asset-delete-*`
       * rendered identically for all three admitted roles, while the backend 403s
       * every one of them (`POST /assets`, `POST /assets/assignments`,
       * `POST /assets/assignments/:id/return`, `DELETE /assets/:id`). A manager
       * was invited to do four things they may not do.
       *
       * The Actions column goes with them — a column of empty cells is its own
       * small lie about what the screen offers.
       */
      crashesOnly(problems);

      const assets = new AssetsPage(page);
      await assets.open();
      await assets.search.fill('E2E-AST-');
      await expect(assets.row('E2E-AST-FREE')).toBeVisible();

      expect(await assets.newButton.count()).toBe(0);
      expect(await assets.assignButton('E2E-AST-FREE').count()).toBe(0);
      expect(await assets.returnButton('E2E-AST-HELD').count()).toBe(0);
      expect(await assets.deleteButton('E2E-AST-FREE').count()).toBe(0);

      // What a MANAGER keeps: the whole register, searchable and readable.
      expect(await assets.rowStatus('E2E-AST-FREE').innerText()).toContain('AVAILABLE');
      settle(problems, 'the write controls a manager is offered');
    });

    test("AST-UI-20 the server still refuses a MANAGER's create, and still says so", async ({
      page,
      problems,
      api,
    }) => {
      crashesOnly(problems);

      /**
       * The other side of AST-UI-18. Hiding a control is a projection, not a
       * guard, and the guard has to be asserted where it is enforced — otherwise
       * the two halves drift and nobody notices until the client is refactored.
       *
       * Driven over the API rather than through the form, because after R74 there
       * is no form for a MANAGER to drive. That is the finding, not a gap in the
       * case.
       */
      const mgrTag = tag('M');
      const mgr = await ApiClient.as('manager');
      await expect(
        mgr.post('/assets', {
          assetTag: mgrTag,
          name: `Manager Laptop ${mgrTag}`,
          category: CATEGORY,
          branchId: HO_BRANCH,
        }),
      ).rejects.toThrow(/403/);
      await mgr.dispose();
      expect(await assetByTag(api, mgrTag)).toBeUndefined();

      // And the register the manager CAN read is unchanged by any of it — no
      // half-written row, no stale count, no dialog.
      const assets = new AssetsPage(page);
      await assets.open();
      await expect(assets.row('E2E-AST-FREE')).toBeVisible();
      expect(await assets.row(mgrTag).count()).toBe(0);
      await expect(permissionModal(page)).toHaveCount(0);

      /**
       * `PermissionDeniedModal` itself was NOT weakened to close R75 — the fix is
       * in the CALLER, which no longer asks a question this role may not ask. The
       * modal still fires from `lib/axios.ts` on every genuine 403, which is why
       * the count above is a claim about this screen rather than about the
       * dialog.
       */
      settle(problems, "a manager's refused create");
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the employee denial');
    });

    test('AST-UI-21 an EMPLOYEE is sent to /403, and the API refuses them too', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);

      // Carried across from assets.spec.ts, which asserted both halves.
      const assets = new AssetsPage(page);
      await assets.open();
      expect(new URL(page.url()).pathname).toBe('/403');

      const emp = await ApiClient.as('employee');
      await expect(emp.get('/assets')).rejects.toThrow(/403/);
      await expect(emp.get('/assets/summary')).rejects.toThrow(/403/);
      await emp.dispose();
      settle(problems, 'the register as an employee');
    });
  });
});
