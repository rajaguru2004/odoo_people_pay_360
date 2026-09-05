import { test, expect, settle, ApiClient } from '../../fixtures';
import { AdvanceLoansPage } from '../../pages';
import { LoanLifecyclePage, LoanToolbar, selectBranch } from '../../pages/loan-lifecycle';
import {
  marker,
  retire,
  ensureAllowance,
  liveLoan,
  loanOf,
  quoteOf,
  scheduleOf,
  branchIdByCode,
  runPayroll,
  lockPayroll,
  clearPayrolls,
  makeEmployee,
  terminateEmployee,
  TestEmployee,
} from '../../loan-support';

/**
 * Who gets TOLD when a loan moves, and what they are told.
 *
 * `finance-loan-lifecycle.spec.ts` proves the money moves. This file is about
 * the other half of every one of those operations: an employee whose recovery
 * was paused, whose balance was forgiven, whose loan was written off has to find
 * out. Nothing on the loan screens announces itself — the notice is a row in
 * `notifications`, written by `NotificationsService.create` from inside the
 * business operation's own call stack.
 *
 * ## Why this is driven over the API rather than through the bell
 *
 * `components/notifications/NotificationBell.tsx` and
 * `app/dashboard/notifications/page.tsx` carry NO `data-testid` at all. The
 * suite's selector policy is data-testid or nothing — labels come from next-intl
 * and exist in English and Arabic, so a text selector encodes the language
 * rather than the intent — so there is no honest way to read the notification
 * list through a browser. `GET /notifications` is therefore the subject, and the
 * single browser case in this file is about the LINK a notice carries rather
 * than about the notice itself.
 *
 * ## What the list endpoint can and cannot answer
 *
 * `NotificationsService.findAll` projects exactly six columns:
 *
 *     id, title, type, isRead, createdAt, link
 *
 * `message` is NOT among them and `type` is `'INFO'` for every notice this
 * module writes, so `link` is the ONLY identity a recipient gets — and it now
 * carries one: `/dashboard/advance-loans/<requestId>`, from
 * `advance-loans.service.ts`, `loan-lifecycle.service.ts` and the loan-repaid
 * notice in `payrolls.service.ts` alike. It used to be a bare module constant,
 * which meant nothing in a row identified WHICH loan it was about; somebody
 * told their loan was written off was handed a page of every loan they had.
 *
 * Arrival is still asserted as a window bounded by a snapshot of the
 * recipient's inbox, because `title` remains the only way to tell one KIND of
 * notice from another. The link is now asserted alongside it.
 *
 * The one discriminator that survives the projection is `title`, and the titles
 * are backend string literals (`'Loan recovery paused'`, `'Loan written off'`, …)
 * rather than translated UI copy: they are produced by the service, travel in
 * the API payload, and never pass through next-intl. Asserting on them is
 * asserting on the server's contract, the same thing the refusal-sentence
 * assertions in `finance-loan-lifecycle.spec.ts` do.
 *
 * ## Fire-and-forget, and the shape that makes it testable
 *
 * Every notification path in this module is wrapped in try/catch and is
 * non-fatal by design — `notifyEmployee` says so in its own comment
 * ("Notification failure must never roll back money that already moved"). The
 * positive form of that property is what is asserted here: after every
 * operation the loan's status or balance has actually moved, whatever the
 * notification list holds. A silent operation is a missing notice, never a
 * missing transaction.
 *
 * ## The silences, and the barrier that makes them provable
 *
 * Three operations move money and tell the employee nothing: manual `close`,
 * `reinstate` and `skipInstallment` have no `notifyEmployee` call at all. Those
 * are asserted as they are, using a BARRIER — a loud operation performed
 * immediately after the silent one, with the window between the snapshot and
 * the barrier's arrival required to hold the barrier's notice and nothing else.
 * Without it, "no notice arrived" and "the poll was too early" are the same
 * observation.
 *
 * ## Marker and allowance discipline
 *
 * `loan_max_active_per_employee` is 2, and this file shares `EMP001` with
 * `loans.admin-employee.spec.ts` and `finance-loan-lifecycle.spec.ts`. Every
 * loan created here carries `pw-loannotify-` in its reason and is retired the
 * moment its test finishes; `liveLoan`/`ensureAllowance` sweep this file's own
 * leftovers before they touch anything else.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The stable half of the marker — what identifies a loan as THIS FILE'S across
 * runs, and what `ensureAllowance` sweeps by. `marker()` adds a per-run suffix
 * on top, so a leftover can be dated as well as owned.
 */
const MARKER_PREFIX = 'pw-loannotify-';

/** Distinct per run and visible on the record, so leftovers are identifiable. */
const MARK = marker(MARKER_PREFIX);

/**
 * The PREFIX every loan notification's link carries. A notice points at the
 * request it is about — `${LOAN_LINK}/${requestId}` — so this is a prefix
 * rather than the whole link.
 *
 * It is also the only way to tell a loan notice from the rest of a shared
 * account's inbox: the payslip notice the payroll case below triggers points at
 * `/dashboard/my-payroll`, and leave, overtime and approval notices point
 * elsewhere again.
 */
const LOAN_LINK = '/dashboard/advance-loans';

/** Exactly what `NotificationsService.findAll` projects. */
interface NotificationRow {
  id: string;
  title: string;
  type: string;
  isRead: boolean;
  createdAt: string;
  link: string | null;
}

/** The corner of the loan record this file reads. */
interface LoanRecord {
  id: string;
  employeeId: string;
  status: string;
  type: string;
  amountRepaid: string;
  waivedAmount: string;
  writtenOffAmount: string;
  closureType: string | null;
  reason: string | null;
}

/** `loanOf` returns the whole open record; this file wants six of its fields. */
async function loanRecord(api: ApiClient, id: string): Promise<LoanRecord> {
  return (await loanOf(api, id)) as unknown as LoanRecord;
}

/**
 * The signed-in user's own notifications, whichever envelope they arrive in.
 *
 * `findAll` returns its own `{ success, data }` and the global interceptor wraps
 * responses too, so the depth of the nesting is not something a spec should
 * depend on.
 */
async function inbox(api: ApiClient): Promise<NotificationRow[]> {
  const raw = await api.get<unknown>('/notifications');
  const box = raw as { data?: unknown } | null;
  const rows = Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box!.data : [];
  return rows as NotificationRow[];
}

/**
 * Only the loan module's notices — see LOAN_LINK.
 *
 * A loan notice now links to the REQUEST (`/dashboard/advance-loans/<id>`)
 * rather than to the module index, so this matches the prefix. It used to be an
 * equality check against the bare constant, which is exactly what stopped
 * matching the day the notices grew an identity: someone told their loan was
 * written off was being handed a page listing all of their loans.
 */
async function loanNotices(api: ApiClient): Promise<NotificationRow[]> {
  return (await inbox(api)).filter((n) => (n.link ?? '').startsWith(LOAN_LINK));
}

/** A snapshot to measure a window against. */
async function loanNoticeIds(api: ApiClient): Promise<Set<string>> {
  return new Set((await loanNotices(api)).map((n) => n.id));
}

/**
 * Loan notices that were not in the snapshot.
 *
 * `loanId` narrows the window to notices about ONE loan. Without it the window
 * is only a moment in time, and a notice raised by the previous case can land
 * inside it — which is exactly what began happening when the notification path
 * gained a log row to write before sending, adding just enough latency to move
 * a notice across a test boundary. A test that asks "did closing this loan say
 * anything?" should not be answerable by what another loan said.
 */
async function arrivedSince(
  api: ApiClient,
  before: Set<string>,
  loanId?: string,
): Promise<NotificationRow[]> {
  const fresh = (await loanNotices(api)).filter((n) => !before.has(n.id));
  return loanId ? fresh.filter((n) => (n.link ?? '').endsWith(`/${loanId}`)) : fresh;
}

async function titlesSince(
  api: ApiClient,
  before: Set<string>,
  loanId?: string,
): Promise<string[]> {
  // Sorted, because WHICH notices arrived is the claim and the order they land
  // in is not. Two notices raised by one operation interleave however the
  // server happens to schedule them — a comparison against a `.sort()`ed
  // expectation was passing on that accident, and started failing the day the
  // notification path gained a log row to write first.
  return (await arrivedSince(api, before, loanId)).map((n) => n.title).sort();
}

/**
 * Waits for one titled notice to land, and hands back everything that arrived.
 *
 * Polled rather than read once because a notification is the LAST thing a
 * business operation does, and no spec should depend on it having finished
 * before the HTTP response came back.
 */
async function awaitNotice(
  api: ApiClient,
  before: Set<string>,
  title: string,
  loanId?: string,
): Promise<NotificationRow[]> {
  await expect
    .poll(() => titlesSince(api, before, loanId), {
      timeout: 15_000,
      message: `no "${title}" notification reached this account`,
    })
    .toContain(title);
  return arrivedSince(api, before, loanId);
}

/** One arrived row, by its server-side title. */
function noticeTitled(rows: NotificationRow[], title: string): NotificationRow {
  const row = rows.find((n) => n.title === title);
  if (!row) throw new Error(`no "${title}" notification among: ${rows.map((r) => r.title).join(', ')}`);
  return row;
}

// ───────────────────────────────────────────────────────────────────────────
// The decision: filing, approving, rejecting
// ───────────────────────────────────────────────────────────────────────────

test.describe('a decision on a request reaches the people it concerns', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, employeeApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only to be
  // thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the loan decision surface is ADMIN/HR');
    });

    test('filing a request tells the approvers there is something to decide', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // ADMIN is in `advance_loan_approver_roles` (ADMIN,HR_MANAGER in the e2e
      // baseline), so this session IS one of the recipients.
      const before = await loanNoticeIds(adminApi);

      await ensureAllowance(employeeApi, adminApi, 600, MARKER_PREFIX);
      const created = await employeeApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 600,
        installments: 6,
        reason: `${MARK} — a request that must reach an approver`,
      });
      scratch.push(created.id);

      const notice = noticeTitled(
        await awaitNotice(adminApi, before, 'New loan request'),
        'New loan request',
      );

      // The notice names the request it is about. `findAll` still drops
      // `message` and `type` is still 'INFO' for every loan notice, so the LINK
      // is the only identity a recipient gets — which is why it has to be the
      // request and not the module index. An approver with three pending
      // requests used to be told only that one of them was new.
      expect(notice.link, 'the approver notice did not name the request it is about')
        .toBe(`${LOAN_LINK}/${created.id}`);
      expect(notice.type, 'the loan module grew a type discriminator').toBe('INFO');
      expect(notice.isRead, 'a brand new notification arrived already read').toBe(false);

      // The non-fatal property in its positive form: the request exists and is
      // awaiting a decision whatever the notification list did.
      expect((await loanRecord(adminApi, created.id)).status).toBe('PENDING');
    });

    test('approval tells the requester, and the loan is approved either way', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const before = await loanNoticeIds(employeeApi);
      const id = await liveLoan(employeeApi, adminApi, {
        amount: 600,
        installments: 6,
        note: `${MARK} approval notice`,
        markerPrefix: MARKER_PREFIX,
      });
      scratch.push(id);

      const notice = noticeTitled(
        await awaitNotice(employeeApi, before, 'Loan approved'),
        'Loan approved',
      );
      expect(notice.link, 'the approval notice did not name the loan').toBe(`${LOAN_LINK}/${id}`);

      expect(
        (await loanRecord(adminApi, id)).status,
        'the notice went out but the decision did not stick',
      ).toBe('APPROVED');
    });

    test('rejection tells the requester, and the request is rejected either way', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await ensureAllowance(employeeApi, adminApi, 600, MARKER_PREFIX);
      const created = await employeeApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 600,
        installments: 6,
        reason: `${MARK} — a request that will be refused`,
      });
      scratch.push(created.id);

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${created.id}/reject`, {
        remarks: `${MARK} refused for the notification journey`,
      });

      const notice = noticeTitled(
        await awaitNotice(employeeApi, before, 'Loan rejected'),
        'Loan rejected',
      );
      expect(notice.link, 'the rejection notice did not name the loan').toBe(
        `${LOAN_LINK}/${created.id}`,
      );

      expect((await loanRecord(adminApi, created.id)).status).toBe('REJECTED');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The lifecycle operations: which of them speak, and which do not
// ───────────────────────────────────────────────────────────────────────────

test.describe('every post-approval operation either tells the employee or is silent', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  const track = async (opts: {
    type?: 'ADVANCE' | 'LOAN';
    amount: number;
    installments?: number;
    note: string;
  }): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, { ...opts, markerPrefix: MARKER_PREFIX });
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, employeeApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only to be
  // thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the money operations are an ADMIN/HR surface');
    });

    test('pausing and resuming recovery are each announced, and each moved the loan', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: `${MARK} hold/resume` });

      const beforeHold = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/hold`, {
        reason: `${MARK} employee is on unpaid leave`,
      });
      await awaitNotice(employeeApi, beforeHold, 'Loan recovery paused');
      // Payroll silently skipping a held loan is exactly the case a person has
      // to be told about, so the record moving is half the claim and the notice
      // is the other half.
      expect((await loanRecord(adminApi, id)).status).toBe('ON_HOLD');

      const beforeResume = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/resume`, { reason: `${MARK} back on payroll` });
      await awaitNotice(employeeApi, beforeResume, 'Loan recovery resumed');
      expect((await loanRecord(adminApi, id)).status).toBe('ACTIVE');
    });

    test('a prepayment is announced, and the balance moved by what was paid', async () => {
      const id = await track({ amount: 600, installments: 6, note: `${MARK} prepay` });

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 200, mode: 'BANK' });

      await awaitNotice(employeeApi, before, 'Prepayment received');

      // The money is the point: a notice about a payment that did not land would
      // be worse than no notice at all.
      expect(Number((await loanRecord(adminApi, id)).amountRepaid)).toBe(200);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(400);
    });

    test('a waiver is announced, and the balance it forgave is gone', async () => {
      const id = await track({ amount: 300, installments: 3, note: `${MARK} waive` });

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/waive`, {
        waiveType: 'BOTH',
        reason: `${MARK} written down under the hardship policy`,
      });

      await awaitNotice(employeeApi, before, 'Loan amount waived');

      const record = await loanRecord(adminApi, id);
      expect(Number(record.waivedAmount)).toBe(300);
      expect(record.closureType).toBe('WAIVER');
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(0);
    });

    test('a write-off is announced, and so is undoing it', async () => {
      const id = await track({ amount: 400, installments: 4, note: `${MARK} write-off` });

      const beforeWriteOff = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/write-off`, {
        reason: `${MARK} uncollectable after the employee left`,
      });
      await awaitNotice(employeeApi, beforeWriteOff, 'Loan written off');

      const written = await loanRecord(adminApi, id);
      expect(Number(written.writtenOffAmount)).toBe(400);
      expect(written.closureType).toBe('WRITE_OFF');

      // Reinstating puts 400 of debt back onto an employee, and it used to send
      // them nothing — the one money-moving operation whose reversal was
      // entirely unannounced. It speaks now.
      const beforeReinstate = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/reinstate`, {
        reason: `${MARK} employee returned and agreed a repayment plan`,
      });

      const reinstated = await loanRecord(adminApi, id);
      expect(reinstated.status).toBe('ACTIVE');
      expect(Number(reinstated.writtenOffAmount), 'the write-off survived its own reversal').toBe(0);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(400);

      await adminApi.post(`/advance-loans/${id}/hold`, { reason: `${MARK} barrier for reinstate` });
      await awaitNotice(employeeApi, beforeReinstate, 'Loan recovery paused');

      // The reinstatement notice and the barrier, in that order — the barrier
      // is kept so a FUTURE silence cannot be mistaken for a slow poll.
      // Sorted: both notices are written fire-and-forget from inside their own
      // operation's call stack, so which row lands first is a race and not a
      // contract. The claim is that BOTH arrived and nothing else did.
      expect(
        (await titlesSince(employeeApi, beforeReinstate)).sort(),
        'reinstate stopped telling the employee their debt is back',
      ).toEqual(['Loan recovery paused', 'Loan reinstated']);
    });

    test('forgiving one instalment moves the schedule and the balance, and says nothing', async () => {
      const id = await track({ amount: 600, installments: 6, note: `${MARK} skip` });

      // Read the row FIRST: the claim below is that the waiver moved the balance
      // by THIS row's principal component, not by a number guessed from the EMI
      // (they differ the moment interest is switched on).
      const target = (await scheduleOf(adminApi, id)).find((r) => r.installmentNo === 3);
      expect(target, 'the approved loan has no third instalment to forgive').toBeTruthy();

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${id}/skip-installment`, {
        installmentNo: 3,
        mode: 'FORGIVE',
        reason: `${MARK} instalment forgiven for hardship`,
      });

      expect(Number((await loanRecord(adminApi, id)).waivedAmount)).toBe(target!.principalComponent);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(
        600 - target!.principalComponent,
      );

      // Barrier — see the write-off case for why a silence needs one.
      await adminApi.post(`/advance-loans/${id}/hold`, { reason: `${MARK} barrier for skip` });
      await awaitNotice(employeeApi, before, 'Loan recovery paused');

      // BUG?: an instalment was forgiven — the employee owes less and their next
      // payslip changes — and `skipInstallment` tells them nothing.
      expect(
        await titlesSince(employeeApi, before),
        'forgiving an instalment stopped telling the employee',
      ).toEqual(['Loan instalment skipped', 'Loan recovery paused'].sort());
    });

    test('both routes out of a live loan tell the employee, each naming its own loan', async () => {
      // One at a time. Holding both open at once is exactly
      // `loan_max_active_per_employee`, and on a database this suite has run
      // against before, making room for the second one retires the first — the
      // prepay below then hits a written-off loan. The window is judged per
      // loan now, so the two halves no longer have to overlap in time.
      const closing = await track({ amount: 600, installments: 6, note: `${MARK} manual close` });

      // 0.50 left of 600 — the "EMI rounding leaves a few cents after the final
      // instalment" case that manual close exists for. The prepayment IS
      // announced, so it happens before the snapshot.
      await adminApi.post(`/advance-loans/${closing}/prepay`, { amount: 599.5, mode: 'BANK' });
      expect((await quoteOf(adminApi, closing)).outstandingPrincipal).toBe(0.5);

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${closing}/close`, {
        reason: `${MARK} residual within tolerance`,
      });
      const closed = await loanRecord(adminApi, closing);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closureType).toBe('MANUAL');

      // The second loan is filed only once the first is closed, so the cap is
      // never contended. It gets a window of its own, opened after its approval
      // notice has already landed — that notice is about this same loan, so
      // scoping alone would not keep it out.
      const foreclosing = await track({ amount: 300, installments: 1, note: `${MARK} foreclose` });
      const beforeForeclose = await loanNoticeIds(employeeApi);

      // Forgiving the sole instalment is the one route that empties the
      // principal WITHOUT closing the loan, which is the state foreclose exists
      // for.
      await adminApi.post(`/advance-loans/${foreclosing}/skip-installment`, {
        installmentNo: 1,
        mode: 'FORGIVE',
        reason: `${MARK} sole instalment forgiven before foreclosure`,
      });
      await adminApi.post(`/advance-loans/${foreclosing}/foreclose`, {
        waiveFutureInterest: false,
        reason: `${MARK} closing a fully forgiven loan`,
      });

      // Scoped to the foreclosed loan: two loans are closed inside this window
      // and `noticeTitled` picks the FIRST row with the title, so an unscoped
      // read here answers the link question about whichever closure landed
      // first rather than about this one.
      const notice = noticeTitled(
        await awaitNotice(employeeApi, beforeForeclose, 'Loan closed', foreclosing),
        'Loan closed',
      );
      expect(notice.link, 'the closure notice did not name the loan').toBe(
        `${LOAN_LINK}/${foreclosing}`,
      );
      expect((await loanRecord(adminApi, foreclosing)).closureType).toBe('FORECLOSED');

      // This used to read the other way round. Two of this employee's loans
      // were closed inside one window and exactly one notice existed, because
      // `LoanLifecycleService.close` had no notifyEmployee call: a manually
      // closed loan left the employee's book in silence, and the single "Loan
      // closed" they DID get was ambiguous between the two loans.
      //
      // Both halves are answered now, so the claim is made per-loan rather than
      // per-window — which is also the only form of it that cannot be broken by
      // an unrelated notice landing a moment late.
      expect(
        await titlesSince(employeeApi, before, closing),
        'the manually closed loan went back to being silent',
      ).toEqual(['Loan closed']);

      // Forgiving the sole instalment is announced in its own right — a
      // deduction that stops appearing on a payslip is what a notice exists for
      // — and the foreclosure that follows closes the loan.
      expect(
        await titlesSince(employeeApi, beforeForeclose, foreclosing),
        'foreclosure stopped announcing itself, or the forgiven instalment went quiet',
      ).toEqual(['Loan closed', 'Loan instalment skipped'].sort());
    });

    test('converting an advance is announced, and the advance really was converted', async () => {
      const advanceId = await track({ type: 'ADVANCE', amount: 200, note: `${MARK} convert` });

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/advance-loans/${advanceId}/convert`, {
        installments: 4,
        reason: `${MARK} spread the advance over four cycles`,
      });

      await awaitNotice(employeeApi, before, 'Advance converted to a loan');

      expect((await loanRecord(adminApi, advanceId)).closureType).toBe('CONVERTED');

      // Conversion CREATES a request rather than mutating the advance, and the
      // new one re-enters approval. Tracked so the allowance is released.
      const mine = await employeeApi.get<LoanRecord[]>('/advance-loans/my-requests');
      const spawned = (Array.isArray(mine) ? mine : []).find(
        (l) =>
          (l as unknown as { convertedFromId?: string }).convertedFromId === advanceId ||
          (l.reason ?? '').includes(advanceId),
      );
      expect(spawned, 'conversion closed the advance without creating the loan').toBeTruthy();
      scratch.push(spawned!.id);
      expect(spawned!.status).toBe('PENDING');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The notice that comes from payroll rather than from the loan screens
// ───────────────────────────────────────────────────────────────────────────

/**
 * The final instalment is not an operation anybody performs — it is a payroll
 * run being locked. `applyLock` flips the request to COMPLETED inside its
 * transaction and then, post-commit and best-effort, tells the requester.
 *
 * That makes it the only loan notice whose sender is the payroll module, and the
 * only one written after the transaction that caused it has already committed —
 * so a failure here genuinely cannot roll the money back, and the assertion is
 * that the money moved AND the notice arrived.
 *
 * ## The salary this run needs, and why it has to be borrowed
 *
 * `seed.ts` ships every one of the four Playwright accounts on `baseSalary: 0`,
 * and `LoanRecoveryService` refuses outright on a zero net ("No loan recovery:
 * net pay for this cycle is zero"). So the ONLY account whose inbox can be read
 * is also an account whose payroll can never recover anything. The rate is
 * therefore raised for exactly as long as it takes to GENERATE the run — the
 * recovery plan is written at generation, and lock merely flips the deductions
 * it planned — and put back immediately afterwards, in a `finally` and again in
 * `afterAll`. `wps.admin.spec.ts` does the same thing for the same reason and
 * does not restore; this one does.
 *
 * The run is targeted at the one employee (`employeeIds`) so that generating it
 * does not attach a PENDING instalment to every live loan in the branch, which
 * is what would block a sibling spec's operations with "Payroll N/YYYY is in
 * progress".
 *
 * ## The attendance carrier
 *
 * `PayrollsService.create` refuses a period in which NO targeted employee has an
 * attendance row ("Attendance for M/YYYY has not been processed yet"), and it
 * also treats an employee with NO attendance rows at all as fully present
 * rather than fully absent. So one throwaway employee is added to the run
 * carrying a single manual attendance day — enough for the run-level guard —
 * while the requester is left with none and is therefore paid in full, which is
 * what makes the instalment affordable. `finance-loan-payroll-recovery.spec.ts`
 * and `finance-loan-concurrency-scale.spec.ts` do exactly this, for the same
 * two rules.
 */
test.describe('a payroll lock that clears a loan tells the requester it is repaid', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let employeeId = '';
  /** Carries the one attendance row that keeps `create()` from refusing. */
  let carrier: TestEmployee | null = null;
  let originalSalary = 0;
  let salaryRaised = false;
  let setupError = '';

  /**
   * Far enough ahead that no other spec's run collides with it, and far enough
   * ahead that the loan's first instalment is already in arrears — the recovery
   * planner sweeps `dueCycleKey <= cycleKey`, so a future period picks up an
   * instalment that came due earlier.
   */
  const period = (() => {
    const now = new Date();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 5, 1));
    return { month: target.getUTCMonth() + 1, year: target.getUTCFullYear() };
  })();

  const restoreSalary = async (): Promise<void> => {
    if (!salaryRaised) return;
    salaryRaised = false;
    await adminApi.patch(`/employees/${employeeId}`, { baseSalary: originalSalary })
      .catch(() => undefined);
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      // The requester's OWN branch: a run generated for any other branch would
      // not contain them, and then there is nothing to recover against.
      branchId = await branchIdByCode(adminApi, 'HO');

      // Small and single-instalment on purpose: one cycle has to clear the whole
      // thing, and a large EMI risks being trimmed by the planner's
      // share-of-net cap and leaving a balance behind.
      loanId = await liveLoan(employeeApi, adminApi, {
        amount: 30,
        installments: 1,
        note: `${MARK} repaid by payroll`,
        markerPrefix: MARKER_PREFIX,
      });
      employeeId = (await loanRecord(adminApi, loanId)).employeeId;

      // A run left behind by a crashed earlier attempt would answer 409 here and
      // fail this file for a reason that has nothing to do with notifications.
      await clearPayrolls(adminApi, branchId, period.month, period.year);

      // One employee in the run must have attendance for the period, or the run
      // is refused before it is ever generated. The carrier holds it, and holds
      // no loan, so the LOP it takes for the other twenty-odd days costs this
      // test nothing.
      carrier = await makeEmployee(adminApi, { marker: `${MARK}carry`, branchId });
      const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;
      await adminApi
        .post('/attendances/manual', {
          employeeId: carrier.id,
          date: day,
          checkIn: `${day}T09:00:00.000Z`,
          checkOut: `${day}T18:00:00.000Z`,
          status: 'PRESENT',
          notes: `${MARK} attendance carrier`,
        })
        .catch(() => undefined);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin')) {
      await restoreSalary();
      // Unlocks and deletes, in that order — a LOCKED run cannot be deleted, and
      // the unlock also reverses the recovery this test performed.
      if (branchId) {
        await clearPayrolls(adminApi, branchId, period.month, period.year).catch(() => undefined);
      }
      if (loanId) await retire(loanId, employeeApi, adminApi);
      if (carrier) await terminateEmployee(adminApi, carrier.id).catch(() => undefined);
    }
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be thrown
  // away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'generating and locking payroll is an ADMIN flow');
    });

    test('the fully-repaid notice lands once the run is locked', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      expect(loanId, 'no loan to recover').toBeTruthy();

      const employee = await adminApi.get<{ baseSalary: string }>(`/employees/${employeeId}`);
      originalSalary = Number(employee.baseSalary ?? 0);

      let payrollId = '';
      try {
        if (originalSalary <= 0) {
          await adminApi.patch(`/employees/${employeeId}`, { baseSalary: 6000 });
          salaryRaised = true;
        }
        const run = await runPayroll(adminApi, {
          month: period.month,
          year: period.year,
          branchId,
          // The carrier rides along only to satisfy the run-level attendance
          // guard; the requester is still the only employee with a loan in it.
          employeeIds: carrier ? [employeeId, carrier.id] : [employeeId],
        });
        payrollId = run.id;
      } finally {
        // The plan is written; the rate is not needed for another instant.
        await restoreSalary();
      }

      expect(payrollId, 'no payroll run was produced for the recovery period').toBeTruthy();

      const before = await loanNoticeIds(employeeApi);
      await adminApi.post(`/payrolls/${payrollId}/submit`, {});
      await adminApi.post(`/payrolls/${payrollId}/approve`, {});
      await lockPayroll(adminApi, payrollId);

      // The money first. COMPLETED is what `applyLock` sets inside its own
      // transaction and is the precondition for the notice existing at all — if
      // the loan is not completed, a missing notice is CORRECT, and the failure
      // is a recovery failure rather than a notification failure.
      await expect
        .poll(async () => (await loanRecord(adminApi, loanId)).status, { timeout: 15_000 })
        .toBe('COMPLETED');

      const notice = noticeTitled(
        await awaitNotice(employeeApi, before, 'Loan fully repaid'),
        'Loan fully repaid',
      );
      expect(notice.link, 'the repaid notice did not name the loan').toBe(
        `${LOAN_LINK}/${loanId}`,
      );

      // The payslip notice from the same lock points somewhere else entirely,
      // which is what makes LOAN_LINK usable as a filter at all.
      const payslip = (await inbox(employeeApi)).find((n) => n.title === 'Your payslip is ready');
      if (payslip) expect(payslip.link).toBe('/dashboard/my-payroll');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Where the link actually goes
// ───────────────────────────────────────────────────────────────────────────

/**
 * The only browser case in this file.
 *
 * A notification whose link 404s, or lands on a screen the recipient cannot
 * read, is worse than no notification: the person has been told something
 * happened and given no way to look at it. So the destination is taken from the
 * API payload — not typed by this spec — and opened.
 */
test.describe('the link a loan notification carries opens a working screen', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
      loanId = await liveLoan(employeeApi, adminApi, {
        amount: 600,
        installments: 6,
        note: `${MARK} link resolution`,
        markerPrefix: MARKER_PREFIX,
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && loanId) await retire(loanId, employeeApi, adminApi);
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be thrown
  // away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'this project holds the approver session the notice was sent to');
    });

    test('following it reaches the loan book, and the loan opens from there', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The admin account is an approver, so filing the loan above put a notice
      // in this session's own inbox — the same session the browser is signed in
      // as, which makes following its link the real gesture rather than a
      // simulation of one.
      const notice = (await loanNotices(adminApi)).find((n) => n.title === 'New loan request');
      expect(notice, 'no approver notice exists to follow').toBeTruthy();

      // The destination is the LOAN, not the list. Every notice in this module
      // used to carry the same constant `/dashboard/advance-loans`, so somebody
      // told their loan was written off was handed a page of every loan there
      // is and left to work out which one had moved.
      expect(notice!.link, 'the notice pointed at the list rather than a loan').toMatch(
        new RegExp(`^${LOAN_LINK}/[0-9a-f-]{36}$`),
      );

      await selectBranch(page, branchId);
      await page.goto(notice!.link!, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // The notice points at the LOAN, so the browser lands on the detail
      // route. The list has to be opened deliberately — `openTab` on the detail
      // page finds no tabs and no toolbar, which is what made the search box
      // time out here.
      const loans = new AdvanceLoansPage(page);
      await loans.open();
      await loans.openTab('all');

      // Narrowed by reference rather than read off page one. The all-requests
      // tab pages at fifty and every loan ever filed stays in the book — no
      // retirement path deletes a row — so on a database that has run this
      // suite a few times the loan under test is simply not on the first page.
      // The claim is that the link lands somewhere the loan can be reached
      // from, not that it happens to be near the top.
      const record = await adminApi.get<{ referenceNo?: string }>(`/advance-loans/${loanId}`);
      const toolbar = new LoanToolbar(page);
      if (record?.referenceNo) await toolbar.search(record.referenceNo);
      await expect.poll(() => loans.hasRow(loanId), { timeout: 15_000 }).toBe(true);

      // And the row leads somewhere real. `loan-status[data-status]` is the
      // machine-readable badge the detail route draws only once the loan, its
      // schedule and its quote have all arrived.
      const detail = new LoanLifecyclePage(page);
      await detail.open(loanId);
      await detail.expectStatus('APPROVED');

      settle(problems, 'following a loan notification to its destination');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Scoping
// ───────────────────────────────────────────────────────────────────────────

/**
 * One employee's loan notices are theirs alone.
 *
 * `findAll` filters on the `userId` in the JWT and there is no way to ask for
 * somebody else's, so the interesting half is the WRITING side: notifications
 * are addressed by looking an `employeeId` up to a user (`notifyEmployee`,
 * `notifyRequester`), and a wrong lookup would put one person's loan history in
 * a colleague's bell without any endpoint being at fault. The boundary is
 * therefore asserted by operating one employee's loan and requiring the other's
 * inbox to stay still.
 *
 * Both sides are seeded accounts because both sides have to be READ: an
 * API-created employee gets a random temporary password that is only emailed, so
 * `makeEmployee` cannot hand back a session. `employee1@company.com` and
 * `employee2@company.com` (linked by `seed-e2e-baseline.ts` so the
 * approval-chain spec has a requester) are the two that can sign in.
 */
test.describe('an employee sees their own loan notifications and nobody else\'s', () => {
  let oneApi: ApiClient;
  let twoApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: Array<{ id: string; owner: ApiClient }> = [];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      oneApi = await ApiClient.as('employee');
      twoApi = await ApiClient.asAccount('employee2@company.com', 'Password123!');
      adminApi = await ApiClient.as('admin');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const { id, owner } of scratch) await retire(id, owner, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    await oneApi?.dispose();
    await twoApi?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs before
  // the page fixture is built, so no browser window is opened only to be thrown
  // away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'both loans are driven from the ADMIN surface');
    });

    test('holding one employee\'s loan leaves the other employee\'s inbox alone', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const loanOne = await liveLoan(oneApi, adminApi, {
        amount: 600,
        installments: 6,
        note: `${MARK} scoping — employee one`,
        markerPrefix: MARKER_PREFIX,
      });
      scratch.push({ id: loanOne, owner: oneApi });

      // employee2 is seeded on a base salary of 0, which the eligibility engine
      // passes deliberately: every salary-relative rule is guarded on
      // `monthlyNet > 0`, so a zero-rate employee is not locked out of borrowing.
      const loanTwo = await liveLoan(twoApi, adminApi, {
        amount: 300,
        installments: 3,
        note: `${MARK} scoping — employee two`,
        markerPrefix: MARKER_PREFIX,
      });
      scratch.push({ id: loanTwo, owner: twoApi });

      const beforeOne = await loanNoticeIds(oneApi);
      const beforeTwo = await loanNoticeIds(twoApi);

      await adminApi.post(`/advance-loans/${loanOne}/hold`, {
        reason: `${MARK} pausing only the first employee's loan`,
      });
      await awaitNotice(oneApi, beforeOne, 'Loan recovery paused');

      // The boundary: the operation named one employee, so only that employee
      // was told. A `notifyEmployee` resolving the wrong user would land here
      // and nowhere else.
      expect(
        await titlesSince(twoApi, beforeTwo),
        'a hold on one employee\'s loan reached another employee',
      ).toEqual([]);

      // And the other way round, so neither half can pass merely because an
      // inbox happened to be quiet.
      const midOne = await loanNoticeIds(oneApi);
      await adminApi.post(`/advance-loans/${loanTwo}/hold`, {
        reason: `${MARK} pausing only the second employee's loan`,
      });
      await awaitNotice(twoApi, beforeTwo, 'Loan recovery paused');
      expect(
        await titlesSince(oneApi, midOne),
        'a hold on one employee\'s loan reached another employee',
      ).toEqual([]);

      // Rows are per-recipient, never shared: no notification id may appear in
      // both inboxes.
      const idsOne = await loanNoticeIds(oneApi);
      const idsTwo = await loanNoticeIds(twoApi);
      expect(
        [...idsOne].filter((id) => idsTwo.has(id)),
        'the same notification row was served to two different accounts',
      ).toEqual([]);

      // Both loans moved, which is what makes the silences above a scoping fact
      // rather than an operation that never happened.
      expect((await loanRecord(adminApi, loanOne)).status).toBe('ON_HOLD');
      expect((await loanRecord(adminApi, loanTwo)).status).toBe('ON_HOLD');
    });
  });
});
