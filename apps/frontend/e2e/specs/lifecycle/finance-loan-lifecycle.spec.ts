import * as XLSX from 'xlsx';
import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage } from '../../pages';
import {
  LoanImportModalPage,
  LoanLifecyclePage,
  LoanToolbar,
  selectBranch,
} from '../../pages/loan-lifecycle';

/**
 * What happens to a loan AFTER somebody approved it.
 *
 * `loans.spec.ts` covers the decision — filing a request and the approver
 * fixing the repayment period. Everything in this file happens later, on the
 * detail route, and it is the half where money actually moves: a prepayment
 * outside payroll, a paused recovery, a forgiven instalment, a written-off
 * balance. Ten operations, each of which changes what an employee owes.
 *
 * Three things make these worth driving through a browser rather than over
 * HTTP, where `finance-loan-surface.e2e-spec.ts` already covers the door:
 *
 *   1. **Which buttons exist is itself a rule.** The panel draws an operation
 *      only when the loan's STATUS permits it and the caller has the capability.
 *      Write-off is gated on `advance_loan_writeoff_roles` — a CSV in
 *      `SystemSetting`, read at request time, defaulting to `'ADMIN'` — and NOT
 *      on the `@Roles('ADMIN','HR_MANAGER')` decorator guarding the route. So an
 *      HR_MANAGER passes the coarse gate and must still be offered no button.
 *      Only a screen test can assert the offer; only an API call can assert the
 *      refusal. Both are here, on the same loan, because either alone proves the
 *      wrong thing.
 *
 *   2. **The refusal has to reach the user in the server's own words.** The
 *      incident recorded in `docs/LOAN-ADVANCES-TEST-CASES.md` is the reason:
 *      "Instalment not found on the live schedule" reached production as "The
 *      operation could not be completed", because `lib/axios.ts` rejects with a
 *      FLAT object and the natural-looking `e.response.data.message` is always
 *      `undefined`. The three refusal cases below assert the SERVER's sentence —
 *      its instalment number, its payoff figure, its tolerance — is what is on
 *      screen, which is the only assertion that would have caught that.
 *
 *   3. **Some refusals must never leave the browser.** `loanGuards.ts` answers
 *      what is answerable from data already on screen, so the reason appears
 *      instantly and the typed form survives. Those cases assert both the exact
 *      sentence AND that no request was made — a guard that quietly stopped
 *      guarding would otherwise still look green.
 *
 * ## The allowance discipline, which is not optional here
 *
 * `loan_max_active_per_employee` is **2**. A file that files freely runs out of
 * allowance a third of the way through and then fails for a reason that has
 * nothing to do with what it was testing. Every loan created here is therefore
 * retired the moment its test is done (`test.afterEach`), and stragglers from a
 * crashed earlier run are swept only when the server says the allowance is
 * actually exhausted — the same `OPEN_STATUSES` / `retire()` / `ensureAllowance()`
 * discipline as `loans.spec.ts`.
 *
 * ## Why each role's half uses a different employee
 *
 * The projects are different workers and can run this file concurrently, so a
 * sweep in one could retire a loan another is halfway through operating on.
 * Each describe therefore owns a distinct subject: `EMP001` for the admin half,
 * the HR manager's own record for the role-gate half, `EMP002` for the importer.
 * They never contend.
 *
 * `EMP001` is NOT this file's alone, though — `loans.spec.ts` files against the
 * same account, in both of its halves. `ensureAllowance` therefore sweeps this
 * file's OWN leftovers (they all carry `MARKER_PREFIX` in their reason) before
 * it will touch anything else, so a full allowance is never made by cancelling
 * the request another spec is halfway through approving.
 *
 * ## The refusal that is NOT this file's to fix
 *
 * Every operation here goes through `assertNoRunInFlight`: if an UNLOCKED
 * payroll (DRAFT / PENDING_APPROVAL / APPROVED) already holds a PENDING
 * instalment for the loan, that run has committed to an amount and the ground
 * must not move under it. The refusal reads:
 *
 *   "Payroll 4/2029 is in progress and already includes an instalment for this
 *    loan. Lock or delete that run first."
 *
 * A payroll run is generated for a whole BRANCH, and the recovery planner sweeps
 * arrears forward (`dueCycleKey <= cycleKey`), so generating one for any future
 * period attaches a PENDING deduction to EVERY live loan in the branch —
 * including one this file created seconds earlier. `payroll-depth.spec.ts` and
 * `wps.spec.ts` generate exactly such runs, for far-future periods, from
 * `beforeAll`, in a parallel worker. Nothing this file can do prevents that; it
 * clears when the other spec locks or deletes its run.
 *
 * So a case here failing with a payroll sentence is suite contention rather than
 * a broken operation, and `LoanLifecyclePage.run()` quotes the sentence so that
 * it is one line to tell apart instead of a bare "the modal is still visible".
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The stable half of the marker — what identifies a loan as THIS FILE'S, across
 * runs. `marker` adds a per-run suffix on top, so a leftover can be dated as
 * well as owned.
 */
const MARKER_PREFIX = 'pw-loanops-';

/** Distinct per run and visible on screen, so leftovers are identifiable. */
const marker = `${MARKER_PREFIX}${Date.now().toString(36)}`;

/**
 * Statuses that still count against the employee's live-loan allowance — the
 * complement of the server's `LOAN_TERMINAL_STATUSES`.
 */
const OPEN_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'DISBURSED',
  'ACTIVE',
  'ON_HOLD',
  'RECEIVABLE',
];

interface LoanRecord {
  id: string;
  status: string;
  type: string;
  amount: string;
  installments: number;
  installmentAmount: string | null;
  amountRepaid: string;
  waivedAmount: string;
  writtenOffAmount: string;
  holdReason: string | null;
  closureType: string | null;
  referenceNo: string | null;
  reason: string | null;
  employeeId: string;
}

interface PayoffQuote {
  outstandingPrincipal: number;
  outstandingInterest: number;
  payoffAmount: number;
  status: string;
}

interface ScheduleRow {
  id: string;
  installmentNo: number;
  status: string;
  emiAmount: string | number;
  principalComponent: string | number;
}

/**
 * The payoff quote, whichever envelope it arrives in.
 *
 * `LoanLifecycleService.payoffQuote` returns its own `{ success, data }` and the
 * global interceptor wraps responses too, so the depth of the nesting is not
 * something a spec should depend on.
 */
async function quoteOf(api: ApiClient, id: string): Promise<PayoffQuote> {
  const raw = await api.get<any>(`/advance-loans/${id}/payoff-quote`);
  return (raw?.data ?? raw) as PayoffQuote;
}

async function scheduleOf(api: ApiClient, id: string): Promise<ScheduleRow[]> {
  const raw = await api.get<any>(`/advance-loans/${id}/schedule`);
  return (Array.isArray(raw) ? raw : (raw?.data ?? [])) as ScheduleRow[];
}

/**
 * Retires ONE loan this file created.
 *
 * Two different exits, because the engine has two: a PENDING request is
 * cancelled by its owner, while a disbursed one carries a balance and `close`
 * refuses it outright ("Outstanding balance is 600, above the rounding
 * tolerance") — writing it off is the operation that actually releases the
 * allowance. Deliberately targeted rather than a sweep of everything the
 * employee owns.
 *
 * Both exits can be refused and both refusals are swallowed on purpose. The one
 * worth naming is `assertNoRunInFlight`: while an unlocked payroll holds an
 * instalment for this loan, NOTHING can be done to it, tidying up included. That
 * clears when the run that claimed it is locked or deleted, and the next run's
 * `ensureAllowance` collects it — so the loan is left rather than fought over.
 */
async function retire(loanId: string, owner: ApiClient, admin: ApiClient): Promise<void> {
  const loan = await owner.get<LoanRecord>(`/advance-loans/${loanId}`).catch(() => null);
  if (!loan || !OPEN_STATUSES.includes(loan.status)) return;

  if (loan.status === 'PENDING' || loan.status === 'DRAFT') {
    await owner.delete(`/advance-loans/${loanId}`).catch(() => undefined);
    return;
  }
  await admin
    .post(`/advance-loans/${loanId}/write-off`, { reason: `${marker} — journey finished` })
    .catch(() => undefined);
}

/**
 * Makes room for one more loan, but only if there is none — and starting with
 * this file's own leftovers.
 *
 * Gated on the server's own eligibility answer rather than run unconditionally:
 * on the reset database this suite documents there is nothing to sweep, and not
 * sweeping is what keeps concurrent projects off each other's records.
 *
 * The two passes are the point. `EMP001` is shared with `loans.spec.ts`, which
 * runs in a different worker and keeps a live loan of its own, so at the cap of
 * two the allowance is short precisely WHEN both files are busy. Sweeping
 * everything the employee owns — which is what a single pass does — then cancels
 * the request the other spec is halfway through approving, and the failure lands
 * over there, in a file that did nothing wrong. So: retire what this run and
 * earlier runs of THIS file left behind first, re-ask the server, and only reach
 * for anything else if that genuinely was not enough.
 */
async function ensureAllowance(owner: ApiClient, admin: ApiClient, amount: number): Promise<void> {
  const eligible = async () =>
    owner
      .post<{ eligible: boolean }>('/advance-loans/eligibility', {
        amount,
        installments: 6,
        type: 'LOAN',
      })
      .then((r) => r.eligible)
      .catch(() => true);

  if (await eligible()) return;

  const mine = await owner
    .get<LoanRecord[] | { data?: LoanRecord[] }>('/advance-loans/my-requests')
    .catch(() => [] as LoanRecord[]);
  const list = Array.isArray(mine) ? mine : (mine?.data ?? []);
  const open = list.filter((l) => OPEN_STATUSES.includes(l.status));
  const ours = (loan: LoanRecord) => (loan.reason ?? '').includes(MARKER_PREFIX);

  for (const loan of open.filter(ours)) await retire(loan.id, owner, admin);
  if (await eligible()) return;

  for (const loan of open.filter((l) => !ours(l))) await retire(loan.id, owner, admin);
}

/**
 * Files a request and approves it, so a test starts from a live loan.
 *
 * Both steps go over the API on purpose: the decision itself is `loans.spec.ts`'s
 * subject, and re-driving it through two screens here would make every case in
 * this file fail for somebody else's reason.
 */
async function liveLoan(
  owner: ApiClient,
  admin: ApiClient,
  opts: { type?: 'ADVANCE' | 'LOAN'; amount: number; installments?: number; note?: string },
): Promise<string> {
  const type = opts.type ?? 'LOAN';
  const installments = type === 'LOAN' ? (opts.installments ?? 1) : 1;

  await ensureAllowance(owner, admin, opts.amount);

  const created = await owner.post<LoanRecord>('/advance-loans', {
    type,
    amount: opts.amount,
    installments: type === 'LOAN' ? installments : undefined,
    reason: `${marker} — ${opts.note ?? 'lifecycle journey'}`,
  });

  try {
    await admin.post(`/advance-loans/${created.id}/approve`, {
      remarks: `${marker} approved for the lifecycle journey`,
      installments: type === 'LOAN' ? installments : undefined,
    });
  } catch (e) {
    // A request the approver refused is still a request, and it still counts
    // against the allowance. The caller never learns the id — it only learns
    // that setup failed — so this is the only place that can take it back.
    await retire(created.id, owner, admin);
    throw e;
  }
  return created.id;
}

// ───────────────────────────────────────────────────────────────────────────
// The ten operations
// ───────────────────────────────────────────────────────────────────────────

test.describe('every post-approval money operation, driven from the screen', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  /** Loans this test created, retired as soon as it finishes. */
  let scratch: string[] = [];

  const track = async (opts: Parameters<typeof liveLoan>[2]): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
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
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the money operations are an ADMIN/HR surface');
    });

    test('pausing recovery holds the loan and the screen says why', async ({ page, problems }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'hold' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      // Polled, not read once. The route renders "Loading…" until the loan, its
      // schedule and its quote have ALL arrived, and `open()`'s networkidle wait
      // is best-effort — so a single read can land on a page that has not drawn a
      // badge yet and report `null` for a loan that is perfectly fine.
      await detail.expectStatus('APPROVED');

      await detail.run('hold', { reason: `${marker} employee is on unpaid leave` });
      await detail.expectStatus('ON_HOLD');

      // The banner is the difference between "nothing is being deducted" and
      // "nothing is being deducted AND here is why" — payroll silently skipping a
      // held loan is exactly the case a user needs told.
      expect(await detail.hasHoldBanner(), 'a held loan showed no explanation').toBe(true);

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.status).toBe('ON_HOLD');
      expect(after.holdReason, 'the reason typed into the dialog never reached the record')
        .toContain(marker);

      settle(problems, 'pausing loan recovery');
    });

    test('a held loan offers resume and nothing that would move money', async ({ page, problems }) => {
      const id = await track({ amount: 600, installments: 6, note: 'resume' });
      await adminApi.post(`/advance-loans/${id}/hold`, {
        reason: `${marker} paused before the journey`,
      });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      // The status is what proves the whole route has rendered, so every "is this
      // offered?" below is asked of a drawn panel rather than of a page that is
      // still loading — where a negative answer would be true for the wrong
      // reason.
      await detail.expectStatus('ON_HOLD');
      expect(await detail.offers('resume')).toBe(true);
      // Recording a payment or re-planning the schedule while recovery is paused
      // is the contradiction the panel exists to prevent.
      expect(await detail.offers('prepay'), 'a paused loan offered a prepayment').toBe(false);
      expect(await detail.offers('skip'), 'a paused loan offered a schedule change').toBe(false);

      await detail.run('resume', { reason: `${marker} back on payroll` });
      await detail.expectStatus('ACTIVE');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.status).toBe('ACTIVE');
      expect(after.holdReason, 'the hold reason outlived the hold').toBeFalsy();

      settle(problems, 'resuming loan recovery');
    });

    test('forgiving one instalment marks that row and moves the balance by its principal', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'skip' });

      // Read the row FIRST: the assertion below is that the waiver moved the
      // balance by this row's principal component, not by a number this spec
      // guessed from the EMI (they differ the moment interest is switched on).
      const before = await scheduleOf(adminApi, id);
      const target = before.find((r) => r.installmentNo === 3);
      expect(target, 'the approved loan has no third instalment to forgive').toBeTruthy();

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 20_000 }).toBe(6);

      // FORGIVE rather than EXTEND deliberately: EXTEND re-amortizes the still-owed
      // balance into a fresh schedule version, so the row under test stops being
      // live and the assertion would be about the amortization engine — which is
      // `loan-amortization.util.spec.ts`'s subject, not this file's.
      await detail.run('skip', {
        'installment-no': '3',
        mode: 'FORGIVE',
        reason: `${marker} instalment forgiven for hardship`,
      });

      await expect
        .poll(() => detail.scheduleRowStatus(3), { timeout: 20_000 })
        .toBe('WAIVED');
      expect(await detail.scheduleRowCount(), 'forgiving one instalment rewrote the plan').toBe(6);

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(Number(after.waivedAmount)).toBe(Number(target!.principalComponent));
      const q = await quoteOf(adminApi, id);
      expect(q.outstandingPrincipal).toBe(600 - Number(target!.principalComponent));

      settle(problems, 'forgiving one instalment');
    });

    test('a payment made outside payroll reduces what is outstanding', async ({ page, problems }) => {
      const id = await track({ amount: 600, installments: 6, note: 'prepay' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 20_000 }).toBe(600);

      await detail.run('prepay', {
        amount: '200',
        mode: 'BANK',
        reference: `${marker}-utr`,
        recalc: 'REDUCE_TENURE',
      });

      // The screen and the record have to agree. A tile that recomputed from the
      // stale loan row would show 600 for as long as nobody reloaded.
      await expect.poll(() => detail.summary('outstanding'), { timeout: 20_000 }).toBe(400);

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(Number(after.amountRepaid)).toBe(200);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(400);
      expect(after.status, 'a part payment closed the loan').toBe('APPROVED');

      settle(problems, 'recording a prepayment');
    });

    test('waiving the whole balance forgives the debt and closes the loan', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 300, installments: 3, note: 'waive' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      // A blank amount means "all of it" — the dialog says so, and the server caps
      // the waiver at the balance rather than trusting the number.
      await detail.run('waive', {
        'waive-type': 'BOTH',
        reason: `${marker} written down under the hardship policy`,
      });
      await detail.expectStatus('CLOSED');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(Number(after.waivedAmount)).toBe(300);
      expect(after.closureType).toBe('WAIVER');
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(0);

      settle(problems, 'waiving a loan balance');
    });

    test('foreclose is offered only once the principal is gone, and then closes the loan', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 300, installments: 1, note: 'foreclose' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      // With a balance still owed there is nothing to foreclose, and a button that
      // always answered 400 would be worse than no button. The status is read
      // first because "no such button" and "no such page yet" look identical from
      // here, and only one of them is the claim.
      await detail.expectStatus('APPROVED');
      expect(await detail.offers('foreclose'), 'foreclose was offered on a loan with a balance')
        .toBe(false);

      // Forgive the single instalment over the API: that is the one route that
      // empties the principal WITHOUT closing the loan, which is precisely the
      // state foreclose exists for.
      await adminApi.post(`/advance-loans/${id}/skip-installment`, {
        installmentNo: 1,
        mode: 'FORGIVE',
        reason: `${marker} sole instalment forgiven`,
      });
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(0);

      await detail.open(id);
      await detail.expectStatus('APPROVED');
      expect(await detail.offers('foreclose'), 'a cleared loan was not offered foreclosure')
        .toBe(true);

      await detail.run('foreclose', {
        waive: 'no',
        reason: `${marker} closing a fully forgiven loan`,
      });
      await detail.expectStatus('CLOSED');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.closureType).toBe('FORECLOSED');

      settle(problems, 'foreclosing a cleared loan');
    });

    test('closing settles a loan whose residual is inside the rounding tolerance', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'close' });
      // 0.50 left of 600 — the "EMI rounding leaves a few cents after the final
      // instalment" case that manual close exists for. Anything at or above the
      // payoff would have closed the loan as an early closure instead.
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 599.5, mode: 'BANK' });
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(0.5);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      await detail.run('close', { reason: `${marker} residual within tolerance` });
      await detail.expectStatus('CLOSED');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.closureType).toBe('MANUAL');

      settle(problems, 'closing a rounded-out loan');
    });

    test('converting an advance files a fresh loan for approval and closes the advance', async ({
      page,
      problems,
    }) => {
      const advanceId = await track({ type: 'ADVANCE', amount: 200, note: 'convert' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(advanceId);
      await detail.expectStatus('APPROVED');
      expect(await detail.offers('convert'), 'an advance was not offered conversion').toBe(true);

      await detail.run('convert', {
        installments: '4',
        reason: `${marker} spread the advance over four cycles`,
      });
      await detail.expectStatus('CLOSED');

      // The claim: conversion CREATES a request rather than mutating the advance,
      // so the already-recovered history stays attached to the terms it was
      // recovered under — and the new terms re-enter approval rather than taking
      // effect because an administrator typed a number.
      const closed = await adminApi.get<LoanRecord>(`/advance-loans/${advanceId}`);
      expect(closed.closureType).toBe('CONVERTED');

      const mine = await employeeApi.get<LoanRecord[]>('/advance-loans/my-requests');
      const spawned = mine.find(
        (l) =>
          (l as unknown as { convertedFromId?: string }).convertedFromId === advanceId ||
          (l.reason ?? '').includes(advanceId),
      );
      expect(spawned, 'conversion closed the advance without creating the loan').toBeTruthy();
      scratch.push(spawned!.id);

      expect(spawned!.type).toBe('LOAN');
      expect(spawned!.status, 'the converted loan took effect without a decision').toBe('PENDING');
      expect(spawned!.installments).toBe(4);
      expect(Number(spawned!.amount)).toBe(200);

      settle(problems, 'converting an advance');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'write-off is restricted to advance_loan_writeoff_roles');
    });

    test('an ADMIN can write off a balance, and only reinstate is left afterwards', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 400, installments: 4, note: 'write-off' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('APPROVED');
      // The positive half of the role gate; the negative half is the HR describe.
      expect(await detail.offers('writeOff'), 'an ADMIN was not offered write-off').toBe(true);

      await detail.run('writeOff', {
        reason: `${marker} uncollectable after the employee left`,
      });
      await detail.expectStatus('WRITTEN_OFF');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(Number(after.writtenOffAmount)).toBe(400);
      expect(after.closureType).toBe('WRITE_OFF');

      // A written-off loan is not simply "finished": the one thing still possible
      // is putting the money back, and the panel must offer that and nothing else.
      await expect.poll(() => detail.operations(), { timeout: 20_000 }).toEqual(['reinstate']);

      settle(problems, 'writing off a loan balance');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'reinstate is restricted to advance_loan_writeoff_roles');
    });

    test('reinstating puts a written-off balance back on the books', async ({ page, problems }) => {
      const id = await track({ amount: 400, installments: 4, note: 'reinstate' });
      await adminApi.post(`/advance-loans/${id}/write-off`, {
        reason: `${marker} written off before the journey`,
      });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      await detail.expectStatus('WRITTEN_OFF');
      expect(await detail.offers('reinstate')).toBe(true);
      expect(await detail.offers('writeOff'), 'a written-off loan was offered a second write-off')
        .toBe(false);

      await detail.run('reinstate', {
        reason: `${marker} employee returned and agreed a repayment plan`,
      });
      await detail.expectStatus('ACTIVE');

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(Number(after.writtenOffAmount), 'the write-off survived its own reversal').toBe(0);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(400);

      settle(problems, 'reinstating a written-off loan');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The write-off role gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * The narrow gate, from the side that must be refused.
 *
 * `advance_loan_writeoff_roles` defaults to `'ADMIN'` and is pinned to it in the
 * e2e baseline, while the route's decorator admits `HR_MANAGER` too. That gap is
 * the whole point: an HR_MANAGER is a legitimate caller of the controller and
 * still must not be able to forgive company money. A test that only checked the
 * decorator would report this surface as covered and be wrong.
 *
 * Uses the HR manager's OWN loan record as the subject, so nothing here contends
 * with the admin half of the file running in a parallel worker.
 */
test.describe('write-off is offered to ADMIN only, not to everyone the route admits', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('hr'), 'the refused half of the write-off gate');
  });

  let hrApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('hr')) return;
    try {
      hrApi = await ApiClient.as('hr');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
      loanId = await liveLoan(hrApi, adminApi, {
        amount: 500,
        installments: 5,
        note: 'write-off role gate',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('hr') && loanId) await retire(loanId, hrApi, adminApi);
    await hrApi?.dispose();
    await adminApi?.dispose();
  });

  test('an HR_MANAGER can operate the loan but is offered no write-off', async ({
    page,
    problems,
  }) => {
    expect(loanId, `setup failed: ${setupError}`).toBeTruthy();

    await selectBranch(page, branchId);
    const detail = new LoanLifecyclePage(page);
    await detail.open(loanId);
    await detail.expectStatus('APPROVED');

    // Not a blanket denial: HR runs the loan book. Everything except the two
    // operations that forgive money is theirs.
    expect(await detail.offers('hold'), 'HR was locked out of the whole panel').toBe(true);
    expect(await detail.offers('waive'), 'HR was refused waiver, which loan_waiver_roles grants')
      .toBe(true);
    expect(await detail.offers('writeOff'), 'an HR_MANAGER was offered write-off').toBe(false);
    expect(await detail.offers('reinstate')).toBe(false);

    settle(problems, 'the HR view of the operations panel');
  });

  test('the API refuses an HR_MANAGER write-off even when asked directly', async () => {
    test.skip(!loanId, 'no loan to write off');

    // A hidden button is a UI decision; this is the rule. Without it the gate
    // would be one `curl` away from irrelevant — and the refusal has to come
    // from the SETTING, since the decorator on this route admits HR_MANAGER.
    await expect(
      hrApi.post(`/advance-loans/${loanId}/write-off`, {
        reason: `${marker} attempting a write-off as HR`,
      }),
    ).rejects.toThrow();

    const after = await hrApi.get<LoanRecord>(`/advance-loans/${loanId}`);
    expect(after.status, 'the refused write-off still changed the loan').not.toBe('WRITTEN_OFF');
    expect(Number(after.writtenOffAmount)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusals: the server's sentence, and the guards that never ask
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every refusal explains itself, in the words of whichever layer refused.
 *
 * The three server cases are arranged by letting the SCREEN go stale — an
 * operation is performed over the API while the page still holds the state it
 * loaded with. That is not a contrivance: it is exactly what happens when two
 * people work the same loan, and it is the only way to get past the client
 * guards to the server's own answer, which is what these cases are about.
 *
 * They are judged `crashesOnly` because a refused request is a 4xx, and the
 * browser logs every 4xx as a console error. Here the 4xx IS the expected
 * outcome; an uncaught render or a 5xx never is, and those stay fatal.
 */
test.describe('a refused operation says exactly why, and says it in the right place', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  const track = async (opts: Parameters<typeof liveLoan>[2]): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, opts);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      employeeApi = await ApiClient.as('employee');
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
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
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the money operations are an ADMIN/HR surface');
    });

    test('skipping an instalment the live schedule no longer has shows the server\'s sentence', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'stale schedule' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 20_000 }).toBe(6);

      // A prepayment that shortens the tenure regenerates the plan and bumps its
      // version, so instalment 6 stops existing. The browser is not told; it still
      // holds the six rows it loaded with, so the client guard sees a perfectly
      // valid target and lets the request through — which is the only way to reach
      // the server's own refusal.
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 300,
        mode: 'BANK',
        recalc: 'REDUCE_TENURE',
      });

      const problem = await detail.attempt('skip', {
        'installment-no': '6',
        mode: 'FORGIVE',
        reason: `${marker} skipping an instalment that has gone`,
      });

      // The exact string from `loan-lifecycle.service.ts`. This assertion is the
      // whole reason the file exists: it is the sentence that reached production
      // as "The operation could not be completed".
      expect(problem).toContain('Instalment not found on the live schedule');
      expect(problem).not.toContain('could not be completed');

      // Refused means refused: the dialog stays open with what was typed, and the
      // loan is untouched.
      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);
      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.status).toBe('APPROVED');

      crashesOnly(problems);
      settle(problems, 'skipping an instalment that is no longer live');
    });

    test('a prepayment above what the loan is now worth shows the server\'s payoff figure', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'stale quote' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 20_000 }).toBe(600);

      // Somebody else pays 400 off. The browser's quote still says 600 is owed, so
      // paying "the payoff amount" is now an overpayment of 400 — and the client
      // guard, working from the stale quote, has no way to know.
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 400, mode: 'CASH' });

      const problem = await detail.attempt('prepay', { amount: '600', mode: 'BANK' });

      // The server names both figures. A generic "invalid amount" would leave the
      // operator guessing what to type instead.
      expect(problem).toContain('exceeds the payoff amount of 200');
      expect(problem).toContain('Pay exactly 200');

      // Refused means refused: the dialog stays open, carrying the reason and the
      // 600 that was typed, so the operator can correct it rather than retype it.
      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);

      const q = await quoteOf(adminApi, id);
      expect(q.outstandingPrincipal, 'the refused prepayment was applied anyway').toBe(200);

      crashesOnly(problems);
      settle(problems, 'a prepayment above the payoff');
    });

    test('closing a loan with a real balance shows the server\'s balance and tolerance', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'close refused' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      // `loanGuards.ts` deliberately does NOT pre-check this one: the threshold is
      // the configurable `loan_rounding_tolerance`, which the client cannot see,
      // and a guessed client copy would refuse closes the server would allow the
      // moment an admin raised it. So this refusal has to travel, and has to
      // arrive intact.
      const problem = await detail.attempt('close', {
        reason: `${marker} trying to close a loan that is still owed`,
      });

      expect(problem).toContain('Outstanding balance is 600');
      expect(problem).toContain('rounding tolerance');
      expect(problem).toMatch(/prepay, waive or write-off/i);

      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);

      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.status, 'a refused close closed the loan').toBe('APPROVED');

      crashesOnly(problems);
      settle(problems, 'closing a loan that still owes money');
    });

    test('an instalment number the loan never had is refused without a round trip', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'client guard: skip' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 20_000 }).toBe(6);

      const problem = await detail.attempt('skip', {
        'installment-no': '50',
        mode: 'EXTEND',
        reason: `${marker} skipping an instalment that cannot exist`,
      });

      // Answered from the schedule already on screen, and answered with the range
      // rather than with "invalid input" — the operator can act on this one.
      expect(problem).toBe(
        'There is no instalment 50. This loan has 6 instalments, numbered 1 to 6.',
      );

      // The proof that it never left the browser: a server refusal would be a 4xx
      // and every non-2xx response on this page is recorded with its URL.
      expect(
        problems.httpErrors.filter((line) => line.includes('skip-installment')),
        'the client guard let the request through to the server',
      ).toEqual([]);

      // A guard refusal is a refusal like any other: the dialog stays, so the 50
      // is still there to be corrected to a number that exists.
      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);

      settle(problems, 'a client-side refusal of an impossible instalment');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'write-off is restricted to advance_loan_writeoff_roles');
    });

    test('a write-off reason that is too short is refused without a round trip', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'client guard: write-off' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      const problem = await detail.attempt('writeOff', { reason: 'short' });

      // The server enforces ten characters. Saying so before the round trip is
      // what stops an operator losing the rest of the form to a rejection.
      expect(problem).toBe(
        'A write-off needs a reason of at least 10 characters — it permanently forgives company money and is audited.',
      );
      expect(
        problems.httpErrors.filter((line) => line.includes('write-off')),
        'the reason-length guard let the request through to the server',
      ).toEqual([]);

      // Cancelling leaves the loan exactly as it was — a refused dialog must not
      // be a half-applied operation. It is still open to be cancelled at all,
      // which is the other half of the same claim.
      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);
      await detail.cancelOp();
      const after = await adminApi.get<LoanRecord>(`/advance-loans/${id}`);
      expect(after.status).toBe('APPROVED');
      expect(Number(after.writtenOffAmount)).toBe(0);

      settle(problems, 'a client-side refusal of a thin write-off reason');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The importer
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bringing existing loans in from a spreadsheet, end to end through the modal.
 *
 * Two phases on purpose: preview parses and validates and persists NOTHING, so
 * an operator can iterate on a bad file without leaving half-imported loans
 * behind, and only the rows preview called valid are sent to confirm. The sheet
 * carries one good row and one bad one precisely so the count of invalid rows is
 * a real number rather than a zero that would pass whatever the code did.
 *
 * Imports against `EMP002`, whose seeded start date is a clean 2025-01-01. The
 * validator refuses a disbursement dated before the employee joined, and the
 * other seeded staff join at seed time — so for them no date in the past is
 * valid and no date in the future is either.
 */
test.describe('the loan importer, through the modal', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an administrative flow');
  });

  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  const reference = `LN-${marker}`.toUpperCase().replace(/[^A-Z0-9/_-]/g, '-');
  let importedId = '';

  /** The fixed column block of the import sheet, in order — the contract. */
  const HEADERS = [
    'Employee Code *',
    'Loan Reference No *',
    'Type (ADVANCE/LOAN) *',
    'Principal Amount *',
    'Interest Method (NONE/FLAT/REDUCING_BALANCE)',
    'Annual Interest Rate %',
    'Total Installments *',
    'EMI Amount',
    'Disbursed On (YYYY-MM-DD) *',
    'First Deduction Month (YYYY-MM) *',
    'Installments Already Paid',
    'Amount Already Repaid',
    'Status (ACTIVE/CLOSED/ON_HOLD)',
    'Notes',
    // Column 15, added when the importer stopped hard-coding MONTHLY: the
    // engine had always supported WEEKLY and QUARTERLY and the sheet could
    // not say so. Blank still means MONTHLY.
    'Deduction Frequency (MONTHLY/WEEKLY/QUARTERLY)',
  ];

  /** Yesterday: past enough to be legal, recent enough to need no maintenance. */
  const disbursedOn = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const nextPeriod = (() => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  })();

  const GOOD_ROW = [
    'EMP002',
    reference,
    'LOAN',
    1200,
    'NONE',
    '',
    12,
    '',
    disbursedOn,
    nextPeriod,
    0,
    0,
    'ACTIVE',
    marker,
  ];

  /**
   * The row that must NOT import: an employee code nobody has, and a principal
   * of zero. Both are the validator's own rules rather than something contrived,
   * and neither can be confused with a blank row (which is skipped, not failed).
   */
  const BAD_ROW = [
    'NO-SUCH-CODE',
    `${reference}-B`,
    'LOAN',
    0,
    'NONE',
    '',
    6,
    '',
    disbursedOn,
    nextPeriod,
    0,
    0,
    'ACTIVE',
    marker,
  ];

  /** Built in memory — no fixture file on disk to drift from the columns. */
  function sheet(): Buffer {
    const ws = XLSX.utils.aoa_to_sheet([HEADERS, GOOD_ROW, BAD_ROW]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Loans');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await adminApi.firstBranchId();
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && importedId) {
      await adminApi
        .post(`/advance-loans/${importedId}/write-off`, {
          reason: `${marker} — imported loan retired after the journey`,
        })
        .catch(() => undefined);
    }
    await adminApi?.dispose();
  });

  test('a template downloads, a sheet previews with its bad row counted, and confirm creates only the good one', async ({
    page,
    problems,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await selectBranch(page, branchId);
    const modal = new LoanImportModalPage(page);
    await modal.open();
    expect(await modal.step()).toBe('UPLOAD');

    // The template is fetched by an authenticated XHR and handed over as an
    // object URL. A plain link would 401, and a test that only asserted the
    // button exists would not notice.
    const template = await modal.downloadTemplate();
    expect(template.length, 'the template download produced no bytes').toBeGreaterThan(0);
    expect(template.subarray(0, 2).toString('latin1'), 'the template is not a workbook').toBe('PK');

    await modal.choose({ name: `${marker}.xlsx`, buffer: sheet() });

    const preview = await modal.preview();
    expect(preview.total).toBe(2);
    expect(preview.valid).toBe(1);
    // Counted and shown, not silently dropped — an operator has to be able to
    // fix the sheet.
    expect(preview.invalid).toBe(1);
    expect(await modal.confirmEnabled()).toBe(true);

    // Preview persists nothing. This is the safety property of a two-phase
    // import and the one an "optimisation" into a single call would lose.
    const beforeConfirm = await adminApi.get<any>(
      `/advance-loans?page=1&limit=25&search=${encodeURIComponent(reference)}`,
    );
    expect(
      (Array.isArray(beforeConfirm) ? beforeConfirm : (beforeConfirm?.data ?? [])).length,
      'preview created a loan',
    ).toBe(0);

    await modal.confirm();
    const results = await modal.results();
    expect(results.imported).toBe(1);
    expect(results.failed).toBe(0);

    // The row exists on the server with the terms the sheet asked for — the
    // screen reporting "1 imported" is not the same claim.
    const found = await adminApi.get<any>(
      `/advance-loans?page=1&limit=25&search=${encodeURIComponent(reference)}`,
    );
    const rows: LoanRecord[] = Array.isArray(found) ? found : (found?.data ?? []);
    const created = rows.find((r) => r.referenceNo === reference);
    expect(created, 'confirm reported an import that produced no loan').toBeTruthy();
    importedId = created!.id;

    expect(created!.type).toBe('LOAN');
    expect(Number(created!.amount)).toBe(1200);
    expect(created!.installments).toBe(12);
    expect(
      OPEN_STATUSES,
      'an imported mid-life loan arrived in a state payroll will never pick up',
    ).toContain(created!.status);

    // A schedule is what payroll recovers against; an imported loan without one
    // is a balance nobody will ever collect.
    expect((await scheduleOf(adminApi, importedId)).length).toBeGreaterThan(0);

    settle(problems, 'importing loans from a spreadsheet');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The list toolbar and the empty states
// ───────────────────────────────────────────────────────────────────────────

/**
 * The toolbar exists only on the admin "All requests" tab, and only there
 * because that is the only tab served by an endpoint that can answer a filter.
 * The other two return a plain array with no filter support, and a search box
 * that silently searched one page would be worse than no search box.
 */
test.describe('the request list narrows on the server, and says so when nothing matches', () => {
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
      branchId = await adminApi.firstBranchId();
      loanId = await liveLoan(employeeApi, adminApi, {
        amount: 450,
        installments: 3,
        note: 'toolbar',
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

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the toolbar is only rendered on the admin tab');
    });

    test('searching narrows the list, and an unmatched search empties it', async ({
      page,
      problems,
    }) => {
      expect(loanId, `setup failed: ${setupError}`).toBeTruthy();

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      const toolbar = new LoanToolbar(page);
      await loans.open();
      await loans.openTab('all');

      expect(await toolbar.isVisible(), 'the admin tab rendered no toolbar').toBe(true);
      await expect.poll(() => loans.hasRow(loanId), { timeout: 20_000 }).toBe(true);

      // The employee code is matched server-side, alongside the name and the
      // reference number — so this is the endpoint answering, not a client filter
      // over one page of rows.
      await toolbar.search('EMP001');
      await expect.poll(() => loans.hasRow(loanId), { timeout: 20_000 }).toBe(true);
      expect((await toolbar.count()).total).toBeGreaterThan(0);

      // The over-filtered empty state: not "there is nothing here" but "nothing
      // matches what you asked for", which is why the reset appears with it.
      await toolbar.search(`${marker}-matches-nothing`);
      await toolbar.expectTotal(0);
      expect(await loans.hasRow(loanId)).toBe(false);
      expect(await toolbar.canClear(), 'an over-filtered list offered no way back').toBe(true);

      await toolbar.clear();
      expect(await toolbar.searchValue()).toBe('');
      await expect.poll(() => loans.hasRow(loanId), { timeout: 20_000 }).toBe(true);

      settle(problems, 'searching the request list');
    });

    test('the status chips are groups, and each asks the server for its own set', async ({
      page,
      problems,
    }) => {
      test.skip(!loanId, 'no loan to filter for');

      await selectBranch(page, branchId);
      const loans = new AdvanceLoansPage(page);
      const toolbar = new LoanToolbar(page);
      await loans.open();
      await loans.openTab('all');

      // Six groups, not thirteen statuses. A chip per enum value is a second copy
      // of the schema; "Active" meaning APPROVED/DISBURSED/ACTIVE is the question
      // people actually ask.
      expect(await toolbar.statusKeys()).toEqual(['all', 'pending', 'live', 'hold', 'done', 'bad']);
      expect(await toolbar.statusValue('live')).toBe('APPROVED,DISBURSED,ACTIVE');
      expect(await toolbar.statusValue('bad')).toBe('REJECTED,CANCELLED,WRITTEN_OFF');
      expect(await toolbar.activeStatus()).toBe('all');

      await toolbar.filterStatus('live');
      expect(await toolbar.activeStatus()).toBe('live');
      await expect.poll(() => loans.hasRow(loanId), { timeout: 20_000 }).toBe(true);

      // The same loan must fall OUT of a group it does not belong to. Without
      // this half the filter could be returning everything and still look right.
      await toolbar.filterStatus('bad');
      expect(await toolbar.activeStatus()).toBe('bad');
      await expect.poll(() => loans.hasRow(loanId), { timeout: 20_000 }).toBe(false);

      settle(problems, 'filtering the request list by status group');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'both admin tabs are needed to reach these two states');
    });

    test('a branch with no loans shows an empty book rather than a broken screen', async ({
      page,
      problems,
    }) => {
      const branches = await adminApi.get<Array<{ id: string; code: string }>>('/branches');
      const candidates = (Array.isArray(branches) ? branches : []).filter((b) => b.code !== 'HO');

      // Ask each candidate whether its book is actually empty rather than
      // assuming the first non-HO branch is. Sibling specs seed loans into
      // branches of their own, and a loan can never be deleted — every
      // retirement path leaves the row in place in a terminal state — so which
      // branches are empty depends on what has run before, not on the seed.
      //
      // The emptiness is judged on the ROWS, not on a total: the list answers
      // `{ data: [...], meta: { total } }` and `ApiClient` unwraps to `data`, so
      // reading `.total` off the result was reading it off an array. It was
      // always undefined, every branch therefore looked empty, and this case
      // silently tested the first non-HO branch — which passed only while that
      // branch happened to have no loans.
      let other: { id: string; code: string } | undefined;
      for (const branch of candidates) {
        const rows = await ApiClient.as('admin').then((c) =>
          c
            .withBranch(branch.id)
            .get<unknown[]>('/advance-loans?page=1&limit=1')
            .finally(() => void c.dispose()),
        );
        if ((Array.isArray(rows) ? rows.length : 0) === 0) {
          other = branch;
          break;
        }
      }
      test.skip(!other, 'every branch already holds loans, so an empty book is not reachable');

      // "Nothing here yet" and "nothing matches your filters" are different facts
      // and get different screens; this is the first of them, reached honestly by
      // pointing the view at a branch that has no loan book at all.
      await selectBranch(page, other!.id);
      const loans = new AdvanceLoansPage(page);
      const toolbar = new LoanToolbar(page);
      await loans.open();

      await loans.openTab('all');
      await toolbar.expectTotal(0);
      expect(await page.getByTestId('loan-row').count()).toBe(0);
      // No filters are set, so the reset is not offered — that is what separates
      // this state from the over-filtered one.
      expect(await toolbar.canClear(), 'an unfiltered empty list offered a filter reset').toBe(false);

      await loans.openTab('pending');
      expect(await page.getByTestId('loan-row').count()).toBe(0);

      settle(problems, 'an empty branch loan book');
    });
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as manager', () => {
    test.beforeEach(() => {
      test.skip(!isProject('manager'), 'a MANAGER is neither an approver nor an administrator here');
    });

    test('a user with no requests of their own gets their own empty state and no admin tabs', async ({
      page,
      problems,
    }) => {
      const api = await ApiClient.as('manager');
      try {
        const mine = await api.get<LoanRecord[] | { data?: LoanRecord[] }>(
          '/advance-loans/my-requests',
        );
        const list = Array.isArray(mine) ? mine : (mine?.data ?? []);
        test.skip(list.length > 0, 'this account already has requests, so the state is unreachable');
      } finally {
        await api.dispose();
      }

      const branch = await (async () => {
        const admin = await ApiClient.as('admin');
        try {
          return await admin.firstBranchId();
        } finally {
          await admin.dispose();
        }
      })();

      await selectBranch(page, branch);
      const loans = new AdvanceLoansPage(page);
      await loans.open();

      // A MANAGER is not in `advance_loan_approver_roles` and is not HR, so only
      // their own history exists for them — and with a single tab the tab bar is
      // not drawn at all.
      expect(await page.getByTestId('loan-tab-pending').count(), 'a non-approver was offered the queue')
        .toBe(0);
      expect(await page.getByTestId('loan-tab-all').count(), 'a non-administrator was offered the book')
        .toBe(0);
      expect(await page.getByTestId('loan-row').count()).toBe(0);

      settle(problems, 'the requester empty state');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Eligibility, before anything is filed
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every rule, visible BEFORE submit.
 *
 * Without the panel the ten-rule eligibility engine only surfaces as an opaque
 * 400 after the form is sent, and the requester is left guessing which of the
 * ten refused them. The claim under test is that each rule is its own row on
 * screen — not that any particular one passes, which depends on how many loans
 * this account happens to be carrying when the suite runs.
 */
test.describe('the request form shows the eligibility rules before anything is filed', () => {
  // Role gate, in a hook rather than in each body: a skip decided here
  // happens before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the request form belongs to the requester');
  });

  test('each rule is a row of its own, with a verdict above them', async ({ page, problems }) => {
    const admin = await ApiClient.as('admin');
    let branchId = '';
    try {
      branchId = await admin.firstBranchId();
    } finally {
      await admin.dispose();
    }

    await selectBranch(page, branchId);
    const loans = new AdvanceLoansPage(page);
    await loans.open();
    await loans.openTab('my');

    await page.getByTestId('loan-new').click();
    const modal = page.getByTestId('loan-create-modal');
    await expect(modal).toBeVisible();

    // The panel is debounced and only appears once there is an amount to judge.
    expect(await page.getByTestId('loan-eligibility-panel').count()).toBe(0);
    await modal.getByTestId('loan-type-LOAN').click();
    await modal.getByTestId('loan-amount').fill('600');

    const verdict = page.getByTestId('loan-eligibility-verdict');
    await expect(verdict).toBeVisible({ timeout: 20_000 });
    expect(['true', 'false']).toContain(await verdict.getAttribute('data-eligible'));

    // The rules that decide a loan, each named. The active-loan cap is the one
    // this whole file has to work around, so it is the one asserted by name.
    const cap = page.getByTestId('loan-eligibility-check-MAX_ACTIVE_LOANS');
    await expect(cap).toBeVisible();
    expect(['PASS', 'WARN', 'FAIL']).toContain(await cap.getAttribute('data-status'));
    await expect(page.getByTestId('loan-eligibility-check-MIN_SERVICE')).toBeVisible();
    await expect(page.getByTestId('loan-eligibility-check-INSTALLMENT_RANGE')).toBeVisible();

    // Nothing was filed: the panel is a what-if and persists nothing, which is
    // what makes it safe to call on every keystroke.
    expect(await page.getByTestId('loan-create-modal').isVisible()).toBe(true);

    settle(problems, 'the eligibility panel on the request form');
  });
});
