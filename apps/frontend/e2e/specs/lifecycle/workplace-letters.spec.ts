import { Page } from '@playwright/test';
import { test, expect, settle, crashesOnly, ApiClient, runId } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { LettersPage } from '../../pages';

/**
 * The letter queue — HR's side of the two-step approval this module owns.
 *
 * Replaces `letters.spec.ts`, which created every request over the API, decided
 * every outcome over the API, and then asserted only that the list page had not
 * crashed — including one case that swallowed a 400 outright with a comment
 * saying that was "fine for this test". The genuine assertions in it (an
 * EMPLOYEE and a MANAGER are both redirected to `/403`, an EMPLOYEE is refused
 * `GET /letters`, a fresh request lands PENDING) are carried across; the rest is
 * driven through the real buttons.
 *
 * What makes this queue worth a journey rather than a route-matrix row: it
 * mints PDFs stating an employee's salary to a third party, off a Postgres
 * sequence, and files them in the employee's vault. An Issue that appears to
 * work but does not, or a Reject that stores no reason, both look identical
 * from a screenshot.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;
const RUN = `${runId}${Math.random().toString(36).slice(2, 6)}`;

interface LetterRow {
  id: string;
  status: 'PENDING' | 'ISSUED' | 'REJECTED';
  serialNumber: string | null;
  documentId: string | null;
  rejectedReason: string | null;
  purpose: string | null;
  templateKey: string;
  /** R66. Absent from the single-row responses; every LIST row carries it. */
  employee?: { status: string; isFormerEmployee: boolean };
}

/**
 * R66's marker, by testid — `e2e/pages/index.ts` is shared by every spec and is
 * not this change's to grow. Belongs on `LettersPage` next time that file is
 * opened.
 */
const formerBadge = (page: Page, id: string) => page.getByTestId(`letter-row-former-${id}`);

/** A PENDING request raised by EMP001, over the API — the prerequisite, not the subject. */
async function seedPending(purpose: string): Promise<LetterRow> {
  const emp = await ApiClient.as('employee');
  const row = await emp.post<LetterRow>('/letters', {
    templateKey: 'SALARY_CERTIFICATE',
    locale: 'en',
    addressedTo: 'Bank Muscat',
    purpose,
  });
  await emp.dispose();
  expect(row.status, 'a SALARY_CERTIFICATE must require approval').toBe('PENDING');
  return row;
}

async function letterById(api: ApiClient, id: string): Promise<LetterRow | undefined> {
  const rows = await api.get<LetterRow[]>('/letters');
  return rows.find((r) => r.id === id);
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

// ─── The queue, as an ADMIN works it ─────────────────────────────────────────

test.describe('the letter queue, as an admin works it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the HR queue is an administrative screen');
  });

  let toIssue: LetterRow;
  let toReject: LetterRow;
  let issuedId = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    toIssue = await seedPending(`admin-issue ${RUN}`);
    toReject = await seedPending(`admin-reject ${RUN}`);
  });

  test('LET-UI-01 the filter defaults to PENDING and changes the set', async ({
    page,
    problems,
  }) => {
    const letters = new LettersPage(page);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          r.url().startsWith(`${API_URL}/letters`) &&
          r.url().includes('status=PENDING'),
      ),
      letters.open(),
    ]);
    // The default is not cosmetic: it is what makes this screen a work queue
    // rather than an archive, and it is sent to the server rather than applied
    // in the browser.
    expect(await letters.statusFilter.inputValue()).toBe('PENDING');
    expect(res.status()).toBe(200);

    await expect(letters.row(toIssue.id)).toBeVisible();
    await expect(letters.row(toReject.id)).toBeVisible();

    /**
     * R66 — the marker is a marker, not decoration.
     *
     * Every list row now carries `employee.status` and a derived
     * `employee.isFormerEmployee`, because a termination is a STATUS change and
     * not a delete: the request outlives its subject's exit, stays PENDING, and
     * sits in this very filter with nothing to say whose it is. The screen marks
     * those rows and only those. `employee1` is serving, so the honest assertion
     * available to a browser journey is the NEGATIVE — a badge on every row
     * would mark nothing, and that is the way this fix fails silently.
     *
     * The positive is asserted where a leaver can be manufactured without
     * driving a whole termination through the UI: `XM-API-16/16b/16c` in
     * `workplace-cross-module.e2e-spec.ts` for the payload, and
     * `app/dashboard/letters/page.test.tsx` for the row and the warning toast.
     */
    await expect(formerBadge(page, toIssue.id)).toHaveCount(0);
    await expect(formerBadge(page, toReject.id)).toHaveCount(0);

    // ISSUED: the baseline's `E2E-BASELINE-0001` is there, the two pending ones
    // are not.
    await letters.statusFilter.selectOption('ISSUED');
    await expect(letters.row(toIssue.id)).toBeHidden();
    await expect(letters.anyRow).toBeVisible();

    await letters.statusFilter.selectOption('REJECTED');
    await expect(letters.row(toIssue.id)).toBeHidden();

    await letters.statusFilter.selectOption('');
    await expect(letters.row(toIssue.id)).toBeVisible();
    settle(problems, 'the letter status filter');
  });

  test('LET-UI-02 issuing through the UI mints a serial, and the API agrees', async ({
    page,
    problems,
    api,
  }) => {
    const letters = new LettersPage(page);
    await letters.open();
    await expect(letters.row(toIssue.id)).toBeVisible();
    expect(await letters.rowStatus(toIssue.id).innerText()).toContain('PENDING');

    await letters.issueButton(toIssue.id).click();

    // The success toast carries the reference, which is the only place the user
    // sees it before the row re-renders.
    await expectToast(page, /Issued/i, 'success');

    // The row leaves the PENDING queue outright — the default filter is still
    // PENDING, so "it disappeared" is the correct on-screen outcome.
    await expect(letters.row(toIssue.id)).toBeHidden({ timeout: 15_000 });
    await letters.statusFilter.selectOption('ISSUED');
    await expect(letters.row(toIssue.id)).toBeVisible({ timeout: 15_000 });
    expect(await letters.rowStatus(toIssue.id).innerText()).toContain('ISSUED');

    // R66, the other half of the negative: no `warning` is minted for a serving
    // employee, so no warning toast is shown. `warning` is a sibling of `data`
    // on the issue envelope, which means a client reading it off the wrong level
    // shows nothing — indistinguishable from this correct silence unless the
    // positive is pinned too, which it is, in the component spec.
    expect(await toastTexts(page, 'warning'), 'a serving employee raises nothing').toBe('');

    const row = await letterById(api, toIssue.id);
    expect(row!.status).toBe('ISSUED');
    // The list projection the badge reads from, asserted at the source.
    expect(row!.employee?.isFormerEmployee, 'employee1 is serving').toBe(false);
    expect(row!.employee?.status).toBe('ACTIVE');
    // The serial comes off the `letter_serial_seq` Postgres sequence, and the
    // vault entry is what makes the letter reachable at all later.
    expect(row!.serialNumber).toBeTruthy();
    expect(row!.documentId).toBeTruthy();
    issuedId = toIssue.id;

    // And the download control appears only once there is a document behind it.
    await expect(letters.downloadButton(toIssue.id)).toBeVisible();
    settle(problems, 'issuing a letter');
  });

  test('LET-UI-03 R5 — a reason below the DTO floor is refused by the CLIENT, and nothing is sent', async ({
    page,
    problems,
    api,
  }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/reject')) posts.push(r.url());
    });

    const letters = new LettersPage(page);
    await letters.open();
    await expect(letters.row(toReject.id)).toBeVisible();

    // Opens the reason box and submits it blank.
    await letters.reject(toReject.id);

    await expectToast(page, /Please enter a reason/i, 'warning');
    expect(posts, 'the client sent a reject with no reason').toHaveLength(0);

    // And the half that only became reachable once the server grew a floor: a
    // non-empty reason that is still too short to be an explanation. The old
    // client gate was `!reason.trim()` alone, so 'no' passed here and came back
    // a 400 — a round trip the user pays for and, before R73, could not read.
    //
    // The reason box is still open (the refusal above returned before closing
    // it), and `rejectButton` TOGGLES — so this fills in place rather than
    // going through `letters.reject`, which would shut the box instead.
    await letters.rejectReason(toReject.id).fill('no');
    await letters.rejectSubmit(toReject.id).click();
    await expectToast(page, /at least 5 characters/i, 'warning');
    expect(posts, 'the client sent a reject below the DTO minimum').toHaveLength(0);

    expect(await letters.rowStatus(toReject.id).innerText()).toContain('PENDING');
    expect((await letterById(api, toReject.id))!.status).toBe('PENDING');

    /**
     * R5 — FIXED, and this case is the client half of the lock.
     *
     * `POST /letters/:id/reject` now binds a real `RejectLetterDto`: `reason`
     * is required, trimmed before validation, `@MinLength(5)`, `@MaxLength(500)`.
     * So the two doors agree, and each is asserted where it is enforced — the
     * server's refusals in `workplace-letters.e2e-spec.ts` (LET-API-08/09),
     * the client's here.
     *
     * That agreement is the thing worth locking. A client floor that drifts
     * from the DTO's does not fail loudly; it just turns a keystroke-time
     * warning into a server round trip carrying a message the user may or may
     * not get to read. The constants live in `REJECT_REASON_MIN` /
     * `REJECT_REASON_MAX` on `app/dashboard/letters/page.tsx` and must track
     * the DTO — this case is what notices when they stop.
     *
     * No `test.fail()` twin: there is no gap left to pin.
     */
    settle(problems, 'rejecting with a reason below the minimum');
  });

  test('LET-UI-04 rejecting with a reason stores it, and the employee is told why', async ({
    page,
    problems,
    api,
  }) => {
    const reason = `Salary data is under review — ${RUN}`;
    const letters = new LettersPage(page);
    await letters.open();
    await expect(letters.row(toReject.id)).toBeVisible();

    await letters.reject(toReject.id, reason);
    await expectToast(page, /Rejected/i, 'success');

    await expect(letters.row(toReject.id)).toBeHidden({ timeout: 15_000 });
    await letters.statusFilter.selectOption('REJECTED');
    await expect(letters.row(toReject.id)).toBeVisible({ timeout: 15_000 });
    expect(await letters.rowStatus(toReject.id).innerText()).toContain('REJECTED');

    const row = await letterById(api, toReject.id);
    expect(row!.status).toBe('REJECTED');
    expect(row!.rejectedReason).toBe(reason);

    // The half that matters to the person who asked: the reason reaches THEIR
    // list, not just HR's. `/dashboard/my-letters` renders `rejectedReason`
    // verbatim, and this is the payload it renders from.
    const emp = await ApiClient.as('employee');
    const mine = await emp.get<LetterRow[]>('/letters/my-requests');
    await emp.dispose();
    expect(mine.find((r) => r.id === toReject.id)!.rejectedReason).toBe(reason);
    settle(problems, 'rejecting a letter with a reason');
  });

  test('LET-UI-05 a settled request offers neither Issue nor Reject', async ({
    page,
    problems,
  }) => {
    const letters = new LettersPage(page);
    await letters.open();

    // `PENDING → ISSUED | REJECTED` are both terminal. The screen must not
    // invite a transition the server would refuse.
    await letters.statusFilter.selectOption('ISSUED');
    await expect(letters.row(issuedId)).toBeVisible();
    expect(await letters.issueButton(issuedId).count()).toBe(0);
    expect(await letters.rejectButton(issuedId).count()).toBe(0);

    await letters.statusFilter.selectOption('REJECTED');
    await expect(letters.row(toReject.id)).toBeVisible();
    expect(await letters.issueButton(toReject.id).count()).toBe(0);
    expect(await letters.rejectButton(toReject.id).count()).toBe(0);
    settle(problems, 'a settled letter request');
  });

  test('LET-UI-06 an issued letter downloads a real PDF through the vault path', async ({
    page,
    problems,
  }) => {
    const letters = new LettersPage(page);
    await letters.open();
    await letters.statusFilter.selectOption('ISSUED');
    await expect(letters.downloadButton(issuedId)).toBeVisible();

    // The bytes, not the click. `vaultService.download` goes through axios so
    // the bearer token is attached — a plain `window.open` sends no
    // Authorization header and 401s, which is the defect this route was built
    // to fix. Asserting the response proves the private file really came back.
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/secure-files/employee-document/') && r.request().method() === 'GET',
        { timeout: 20_000 },
      ),
      letters.downloadButton(issuedId).click(),
    ]);

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    const body = await res.body();
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    settle(problems, 'downloading an issued letter');
  });
});

// ─── The same queue, as HR ───────────────────────────────────────────────────

test.describe('the letter queue, as HR works it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the HR pass over the queue');
  });

  let toIssue: LetterRow;
  let toReject: LetterRow;

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    toIssue = await seedPending(`hr-issue ${RUN}`);
    toReject = await seedPending(`hr-reject ${RUN}`);
  });

  test('LET-UI-07 HR issues from the same queue, and the API agrees', async ({
    page,
    problems,
  }) => {
    const letters = new LettersPage(page);
    await letters.open();
    await expect(letters.row(toIssue.id)).toBeVisible();
    await letters.issueButton(toIssue.id).click();
    await expectToast(page, /Issued/i, 'success');

    await letters.statusFilter.selectOption('ISSUED');
    await expect(letters.row(toIssue.id)).toBeVisible({ timeout: 15_000 });

    const hr = await ApiClient.as('hr');
    const row = (await hr.get<LetterRow[]>('/letters?status=ISSUED')).find(
      (r) => r.id === toIssue.id,
    );
    await hr.dispose();
    expect(row!.status).toBe('ISSUED');
    expect(row!.serialNumber).toBeTruthy();
    settle(problems, 'HR issuing a letter');
  });

  test('LET-UI-08 HR rejects with a reason', async ({ page, problems }) => {
    const reason = `Not supported by payroll records — ${RUN}`;
    const letters = new LettersPage(page);
    await letters.open();
    await expect(letters.row(toReject.id)).toBeVisible();
    await letters.reject(toReject.id, reason);
    await expectToast(page, /Rejected/i, 'success');

    const hr = await ApiClient.as('hr');
    const row = (await hr.get<LetterRow[]>('/letters?status=REJECTED')).find(
      (r) => r.id === toReject.id,
    );
    await hr.dispose();
    expect(row!.status).toBe('REJECTED');
    expect(row!.rejectedReason).toBe(reason);
    settle(problems, 'HR rejecting a letter');
  });
});

// ─── Denial ──────────────────────────────────────────────────────────────────

test.describe('the letter queue, for the roles it is not for', () => {
  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'the manager denial');
    });

    test('LET-UI-09 a MANAGER is sent to /403 and the API refuses them', async ({
      page,
      problems,
    }) => {
      // A denial logs its 403; only a crash is a failure on a screen this role is
      // not meant to have.
      crashesOnly(problems);

      const letters = new LettersPage(page);
      await letters.open();
      expect(new URL(page.url()).pathname).toBe('/403');

      // Both halves, because the client guard and the server rule are separate
      // decisions and either can drift. A MANAGER is refused the queue even
      // though they can read a subordinate's asset custody — "a manager has no
      // business reading a subordinate's salary certificate".
      const mgr = await ApiClient.as('manager');
      await expect(mgr.get('/letters')).rejects.toThrow(/403/);
      await mgr.dispose();
      settle(problems, 'the letter queue as a manager');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as employee', () => {
    test.beforeEach(() => {
      test.skip(!isProject('employee'), 'the employee denial');
    });

    test('LET-UI-10 an EMPLOYEE is sent to /403 and the API refuses them', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);

      const letters = new LettersPage(page);
      await letters.open();
      expect(new URL(page.url()).pathname).toBe('/403');

      const emp = await ApiClient.as('employee');
      await expect(emp.get('/letters')).rejects.toThrow(/403/);
      // Deciding is A/HR only, and the employee cannot decide even their own.
      await expect(emp.post('/letters/00000000-0000-0000-0000-000000000000/issue', {})).rejects.toThrow(
        /403/,
      );
      await emp.dispose();
      settle(problems, 'the letter queue as an employee');
    });
  });
});
