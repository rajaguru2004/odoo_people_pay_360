import { Page } from '@playwright/test';
import { test, expect, settle, ApiClient, runId } from '../../fixtures';
import { MyLettersPage, MyDocumentsPage } from '../../pages';

/**
 * "My Letters" and "My Documents" — the employee's side of the letter module.
 *
 * Replaces the ESS half of `letters.spec.ts`, whose "employee requests a letter
 * and it appears in the list" case raised the request over the API and then
 * asserted, in its own words, that "the important thing is no crash".
 *
 * The two branches this screen has to get right are genuinely different
 * products behind one button:
 *
 *  * `requiresApproval: true` (SALARY_CERTIFICATE) — the request lands PENDING
 *    and waits for HR. Stating someone's pay to a bank is never instant.
 *  * `requiresApproval: false` (EXPERIENCE) — `LettersService.request()` calls
 *    `issue()` INLINE, so the employee gets a serial, a rendered PDF and a
 *    vault entry with no HR step at all. Backend finding R4 covers what happens
 *    when that inline call throws; asserted here is what the USER sees when it
 *    does not.
 *
 * ## R17 — neither page carried a `ProtectedRoute`. Fixed.
 *
 * `/dashboard/my-letters` and `/dashboard/my-documents` were server-gated only.
 * Both are now wrapped in the same bare `<ProtectedRoute>` as
 * `/dashboard/my-assets` — a guard about authentication, not about audience.
 * The two cases below are what stop that ever being read as licence to narrow
 * a self-service screen by role. See the header of
 * `workplace-my-assets.spec.ts` for the whole argument.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`;

interface LetterRow {
  id: string;
  status: 'PENDING' | 'ISSUED' | 'REJECTED';
  serialNumber: string | null;
  documentId: string | null;
  templateKey: string;
  purpose: string | null;
}

/** The employee's own list, read back over the API to find what the form created. */
async function mineByPurpose(purpose: string): Promise<LetterRow | undefined> {
  const emp = await ApiClient.as('employee');
  const rows = await emp.get<LetterRow[]>('/letters/my-requests');
  await emp.dispose();
  return rows.find((r) => r.purpose === purpose);
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

let HO_BRANCH = '';

test.beforeAll(async () => {
  const api = await ApiClient.as('admin');
  HO_BRANCH = await api.firstBranchId();
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await primePage(page, HO_BRANCH);
});

// ─── Requesting, as the employee ─────────────────────────────────────────────

test.describe('my letters, as the employee who asks for them', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the requester journey');
  });

  const pendingPurpose = `Mortgage application ${RUN}`;
  const autoPurpose = `Visa file ${RUN}`;
  let pendingId = '';
  let autoIssued: LetterRow | undefined;

  test('MYL-UI-01 a SALARY_CERTIFICATE lands PENDING and reaches HR', async ({
    page,
    problems,
  }) => {
    const my = new MyLettersPage(page);
    await my.open();
    await my.request({
      templateKey: 'SALARY_CERTIFICATE',
      locale: 'en',
      addressedTo: 'Bank Muscat',
      purpose: pendingPurpose,
    });

    // The wording matters: this branch promises a review, and the other one
    // promises a document. Telling them apart is the whole point of the toast.
    await expectToast(page, /HR will review/i, 'success');

    const row = await mineByPurpose(pendingPurpose);
    expect(row, 'the request the form filed is not in /letters/my-requests').toBeTruthy();
    pendingId = row!.id;
    expect(row!.status).toBe('PENDING');
    expect(row!.serialNumber).toBeNull();

    await expect(my.row(pendingId)).toBeVisible({ timeout: 15_000 });
    expect(await my.status(pendingId).innerText()).toContain('PENDING');
    // Nothing to download until HR has acted.
    expect(await my.downloadButton(pendingId).count()).toBe(0);

    /**
     * R66 — this screen and HR's must not disagree.
     *
     * `GET /letters/my-requests` carries the same `employee.isFormerEmployee`
     * card as `GET /letters`, and `/dashboard/my-letters` renders the same
     * badge, so a request marked as a leaver's in the queue is marked as one
     * here too. `employee1` is serving, so this is the negative; the badge on
     * every row would be the failure, and it is the one this asserts against.
     * Addressed by testid rather than through `MyLettersPage` — `e2e/pages` is
     * shared and not this change's to grow.
     */
    await expect(page.getByTestId(`my-letter-former-${pendingId}`)).toHaveCount(0);

    // And it is in the queue HR actually opens — `GET /letters?status=PENDING`
    // is what `/dashboard/letters` loads by default.
    const hr = await ApiClient.as('hr');
    const queue = await hr.get<LetterRow[]>('/letters?status=PENDING');
    await hr.dispose();
    expect(queue.some((r) => r.id === pendingId)).toBe(true);
    settle(problems, 'requesting a salary certificate');
  });

  test('MYL-UI-02 an EXPERIENCE letter auto-issues, with no HR step at all', async ({
    page,
    problems,
  }) => {
    const my = new MyLettersPage(page);
    await my.open();
    await my.request({ templateKey: 'EXPERIENCE', locale: 'en', purpose: autoPurpose });

    // The other promise. `requiresApproval: false` collapses both steps inside
    // `request()`, so the user is told the letter already exists.
    await expectToast(page, /issued/i, 'success');

    autoIssued = await mineByPurpose(autoPurpose);
    expect(autoIssued).toBeTruthy();
    expect(autoIssued!.status).toBe('ISSUED');
    // A serial off `letter_serial_seq` and a filed vault document, both minted
    // inline. Either being absent means the inline `issue()` half-ran.
    expect(autoIssued!.serialNumber).toBeTruthy();
    expect(autoIssued!.documentId).toBeTruthy();

    await expect(my.row(autoIssued!.id)).toBeVisible({ timeout: 15_000 });
    expect(await my.status(autoIssued!.id).innerText()).toContain('ISSUED');
    await expect(my.downloadButton(autoIssued!.id)).toBeVisible();

    // It never entered HR's queue, which is the difference from MYL-UI-01.
    const hr = await ApiClient.as('hr');
    const queue = await hr.get<LetterRow[]>('/letters?status=PENDING');
    await hr.dispose();
    expect(queue.some((r) => r.id === autoIssued!.id)).toBe(false);
    settle(problems, 'requesting an experience letter');
  });

  test('MYL-UI-03 the issued letter downloads as a real PDF', async ({ page, problems }) => {
    const my = new MyLettersPage(page);
    await my.open();
    await expect(my.downloadButton(autoIssued!.id)).toBeVisible();

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/secure-files/employee-document/') && r.request().method() === 'GET',
        { timeout: 20_000 },
      ),
      my.downloadButton(autoIssued!.id).click(),
    ]);

    // The file is stored behind a `private://` ref, so the only way to it is
    // this authenticated route. Asserting the bytes is what separates "the
    // button did something" from "the employee has their letter".
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    const body = await res.body();
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    settle(problems, 'downloading an issued letter from my-letters');
  });

  test('MYL-UI-04 the issued letter is filed in the vault, and opens from there too', async ({
    page,
    problems,
  }) => {
    const docs = new MyDocumentsPage(page);
    await docs.open();

    // `issue()` writes an `EmployeeDocument` with `isSystemGenerated: true`, so
    // the letter has to appear on the one screen that claims to hold
    // "everything the company holds for you".
    const docId = autoIssued!.documentId!;
    await expect(docs.row(docId)).toBeVisible({ timeout: 15_000 });
    expect(await docs.row(docId).getAttribute('data-kind')).toBe('LETTER');

    await docs.kindFilter.selectOption('LETTER');
    await expect(docs.row(docId)).toBeVisible();

    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/secure-files/employee-document/') && r.request().method() === 'GET',
        { timeout: 20_000 },
      ),
      docs.downloadButton(docId).click(),
    ]);
    expect(res.status()).toBe(200);
    expect((await res.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');

    // A search that matches nothing says so rather than blanking the table.
    await docs.kindFilter.selectOption('');
    await docs.search.fill(`no-such-document-${RUN}`);
    await expect(docs.empty).toBeVisible();
    settle(problems, 'the vault entry for an issued letter');
  });
});

// ─── R17: the two unguarded ESS pages ────────────────────────────────────────

test.describe('my letters and my documents, as a role with nothing in them', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the ESS-guard pass');
    });

    test('MYL-UI-05 R17: /dashboard/my-letters is guarded without being narrowed', async ({
      page,
      problems,
    }) => {
      /**
       * R17, fixed. `app/dashboard/my-letters/page.tsx` used to export its
       * component directly, with no `<ProtectedRoute>` at all, while its
       * administrative sibling `/dashboard/letters` sends this same MANAGER to
       * `/403` (LET-UI-09). That contrast was the finding.
       *
       * The page is guarded now — and deliberately not by role. Asking for your
       * own salary certificate is not an administrative act; a MANAGER is
       * entitled to it exactly as an EMPLOYEE is. So the guard answers "is
       * anybody signed in?" and the server answers "whose letters are these?",
       * which is what this case pins: the manager arrives, and is shown their own
       * empty list rather than /403.
       */
      const my = new MyLettersPage(page);
      await my.open();

      const landed = new URL(page.url()).pathname;
      expect(landed, 'the ESS guard narrowed a self-service screen by role').not.toBe('/403');
      expect(landed).toBe('/dashboard/my-letters');
      // MGR001 has never asked for a letter, so the scoping is the server's:
      // `my-requests` is keyed on the caller's own employee id.
      await expect(my.empty).toBeVisible();
      expect(await page.locator('[data-testid^="my-letter-row-"]').count()).toBe(0);
      // The request form is offered to them all the same, which is the whole
      // point — every role may ask for their own letter.
      await expect(my.requestOpen).toBeVisible();
      settle(problems, 'my-letters as a manager');
    });

    test('MYL-UI-07 R17: /dashboard/my-documents is guarded without being narrowed', async ({
      page,
      problems,
    }) => {
      // Same fix, third page. The vault is the screen that would leak the most if
      // its scoping were ever client-side, which is why "it is empty because the
      // SERVER said so" is worth an assertion of its own — the client guard adds
      // an authentication check in front of that and changes nothing about it.
      const docs = new MyDocumentsPage(page);
      await docs.open();

      const landed = new URL(page.url()).pathname;
      expect(landed, 'the ESS guard narrowed a self-service screen by role').not.toBe('/403');
      expect(landed).toBe('/dashboard/my-documents');
      await expect(docs.empty).toBeVisible();
      expect(await page.locator('[data-testid^="document-row-"]').count()).toBe(0);

      const mgr = await ApiClient.as('manager');
      const vault = await mgr.get<{ items: unknown[] }>('/document-vault/me');
      await mgr.dispose();
      expect(vault.items).toHaveLength(0);
      settle(problems, 'my-documents as a manager');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the unguarded-page pass');
    });

    test('MYL-UI-09 an admin with no letters sees the empty state, not a crash', async ({
      page,
      problems,
    }) => {
      const my = new MyLettersPage(page);
      await my.open();
      expect(new URL(page.url()).pathname).toBe('/dashboard/my-letters');
      await expect(my.empty).toBeVisible();
      settle(problems, 'my-letters as an admin');
    });
  });
});
