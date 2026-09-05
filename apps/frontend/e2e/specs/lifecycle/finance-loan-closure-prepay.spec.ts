import { randomUUID } from 'crypto';
import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { ALL_OPS, LoanLifecyclePage, LoanOp, selectBranch } from '../../pages/loan-lifecycle';
import {
  clearPayrolls,
  deductionsFor,
  deletePayroll,
  flagFlipAllowed,
  liveLoan,
  loanOf,
  marker,
  quoteOf,
  retire,
  retireAllMarked,
  runPayroll,
  scheduleOf,
  withSetting,
} from '../../loan-support';

/**
 * The EDGES of closure and prepayment — catalogue §8 and §9.
 *
 * `finance-loan-lifecycle.spec.ts` is the journey: it proves each of the ten
 * operations works once, from the screen, and that three refusals arrive in the
 * server's own words. This file is the other half of the same surface — the
 * boundaries, the bounds and the states where an operation must NOT work. It
 * deliberately re-runs nothing from there:
 *
 *   • that file records a PARTIAL prepayment; this one pays the payoff exactly,
 *     one minor unit over it, twice in a month, in every mode, with every
 *     malformed amount the DTO rejects, and twice with the same idempotency key.
 *   • that file closes a loan whose residual is INSIDE the tolerance; this one
 *     closes one sitting exactly ON it, refuses one just above it, and raises
 *     the tolerance until the bigger residual closes.
 *   • that file waives the whole balance as BOTH; this one takes each
 *     `waiveType` in turn and asks what happens when the amount exceeds the
 *     balance it is aimed at.
 *   • that file writes off a whole loan; this one writes off part of one first,
 *     and stands on the ten-character boundary of the reason rather than a
 *     mile inside it.
 *
 * ## Three rules this file follows, and why
 *
 * **1. A refusal is only interesting if you know WHICH layer refused it.**
 * `loanGuards.ts` answers everything answerable from data already on screen, so
 * the reason lands instantly and the typed form survives; the server re-checks
 * all of it plus the money ceilings and the role lists. Every guard case here
 * therefore asserts the exact sentence AND that `problems.httpErrors` carries
 * no call to the endpoint — a guard that quietly stopped guarding would
 * otherwise still look green, because the server would refuse it anyway.
 *
 * **2. Some of these cases cannot be driven from a screen at all**, and saying
 * so is part of the coverage. The prepayment dialog has no `paidOn` and no
 * `idempotencyKey` field; the foreclose button is not drawn while principal
 * remains; a PENDING loan draws no operations panel. Those are asserted over
 * the API, with the UI half asserted as "not offered" where there is a screen
 * to look at.
 *
 * **3. The allowance is 2 live loans per employee**, and this file cannot own
 * its subject. `makeEmployee()` creates a real, paid, branch-scoped employee but
 * NOT a usable login — `POST /employees` mints a random temporary password that
 * is only emailed — and `POST /advance-loans` files against the CALLER's own
 * employee record, with no on-behalf route. So a loan can only be requested by
 * one of the seeded accounts. This file uses `employee2@company.com`, the least
 * contended of them for loan requests (`loans.spec.ts` and the lifecycle
 * journey both work `EMP001`), retires every loan the moment its case ends, and
 * sweeps only what carries `pw-loanclose-` — so a tidy-up here can never cancel
 * the request another spec is halfway through approving.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half — what identifies a loan as THIS file's, across runs. */
const MARKER_PREFIX = 'pw-loanclose-';

/** Distinct per run and visible on screen, so a leftover can be dated. */
const MARKER = marker(MARKER_PREFIX);

/** A reason that clears the 10-character write-off floor with room to spare. */
const AUDITED = `${MARKER} uncollectable after the employee left the company`;

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
  closureType: string | null;
  reason: string | null;
  employeeId: string;
  deductions?: Array<{ id: string; status: string; month: number; year: number }>;
}

/**
 * The loan record, named.
 *
 * `loanOf` returns the detail route's whole payload as an open record — every
 * spec wants a different corner of it, and its money columns are Decimal, so
 * they arrive as STRINGS. Naming the corner this file reads keeps `Number(...)`
 * at the assertion rather than scattered through it. `quoteOf` and `scheduleOf`
 * already return typed numbers, so they are used directly.
 */
const record = async (api: ApiClient, id: string): Promise<LoanRecord> =>
  (await loanOf(api, id)) as unknown as LoanRecord;
const quote = quoteOf;
const rows = scheduleOf;

/**
 * Runs a call that is EXPECTED to be refused and returns what came back.
 *
 * `ApiClient` throws `<METHOD> <path> failed: <status> <body>`, so one string
 * carries both the status code and the server's sentence — and asserting on
 * both is the point. A call that unexpectedly SUCCEEDS returns the empty
 * string, which every caller asserts against first, so "it went through" never
 * reads as "the message did not match".
 */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * The endpoint and a minimally valid body for each operation.
 *
 * Thirteen now: `disburse`, `rate-change` and `topup` are operations on a live
 * loan like the rest, so a terminal loan has to refuse them too — which is
 * exactly what this map is swept for.
 */
const OP_CALL: Record<LoanOp, { path: string; body: Record<string, unknown> }> = {
  prepay: { path: 'prepay', body: { amount: 10, mode: 'CASH' } },
  skip: {
    path: 'skip-installment',
    body: { installmentNo: 1, mode: 'FORGIVE', reason: `${MARKER} terminal sweep` },
  },
  hold: { path: 'hold', body: { reason: `${MARKER} terminal sweep` } },
  resume: { path: 'resume', body: { reason: `${MARKER} terminal sweep` } },
  convert: { path: 'convert', body: { installments: 3, reason: `${MARKER} terminal sweep` } },
  waive: { path: 'waive', body: { reason: `${MARKER} terminal sweep` } },
  foreclose: { path: 'foreclose', body: { reason: `${MARKER} terminal sweep` } },
  close: { path: 'close', body: { reason: `${MARKER} terminal sweep` } },
  writeOff: { path: 'write-off', body: { reason: `${MARKER} terminal sweep, ten characters and more` } },
  reinstate: { path: 'reinstate', body: { reason: `${MARKER} terminal sweep` } },
  disburse: { path: 'disburse', body: {} },
  rateChange: {
    path: 'rate-change',
    body: { newMethod: 'FLAT', newRate: 6, reason: `${MARKER} terminal sweep` },
  },
  topup: {
    path: 'topup',
    body: { amount: 1000, installments: 4, reason: `${MARKER} terminal sweep` },
  },
};

test.describe('closing a loan and paying it off early, at the edges', () => {
  /** The requester every loan in this file belongs to. */
  let ownerApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let tolerance = 1;
  let setupError = '';

  /** Loans this case created, retired as soon as it finishes. */
  let scratch: string[] = [];

  const track = async (opts: {
    type?: 'ADVANCE' | 'LOAN';
    amount: number;
    installments?: number;
    note?: string;
  }): Promise<string> => {
    const id = await liveLoan(ownerApi, adminApi, {
      ...opts,
      note: `${MARKER} — ${opts.note ?? 'closure journey'}`,
      // The note already opens with the marker, so the default would be right —
      // but the allowance sweep matches on the STABLE half, and stating it is
      // what stops a future edit to the note silently narrowing the sweep to
      // this run alone.
      markerPrefix: MARKER_PREFIX,
    });
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');

      // `employee2` where the baseline seeded it, `employee1` otherwise. The
      // fallback is not decoration: it is the account `loans.spec.ts` and the
      // lifecycle journey both work, so landing on it means the allowance is
      // genuinely contended and every case here has to retire what it made.
      ownerApi = await ApiClient.asAccount('employee2@company.com', 'Password123!').catch(
        () => ApiClient.as('employee'),
      );

      branchId = await adminApi.firstBranchId();

      // Read rather than assume: `loan_rounding_tolerance` is not pinned by the
      // e2e baseline, so the boundary this file stands on is whatever the
      // database says it is. `GET /system-settings` answers with an ARRAY of
      // `{ key, value }`, carrying the server's own default for a key with no
      // row — which is what makes reading it honest rather than a guess.
      const settings = await adminApi.get<Array<{ key: string; value: string }>>('/system-settings');
      const row = (Array.isArray(settings) ? settings : []).find(
        (s) => s.key === 'loan_rounding_tolerance',
      );
      tolerance = Number(row?.value ?? 1) || 1;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  // The role gate lives in a hook rather than in each body: a skip decided here
  // runs before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the money operations are an ADMIN/HR surface');
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, ownerApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && ownerApi && adminApi) {
      // Stragglers from a crashed earlier run of THIS file, identified by the
      // stable half of the marker and nothing else.
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
    await ownerApi?.dispose();
    await adminApi?.dispose();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §9 Prepayment
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('a prepayment', () => {
    test('paying exactly the payoff closes the loan as an early closure', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'exact payoff' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      // `loan-summary-payoff` is a DUAL-PURPOSE tile: it only carries the
      // payoff quote when the loan bears interest, and otherwise renders the
      // INSTALMENT (600 over 6 ⇒ 100) under the label "Instalment". This loan
      // is interest-free, so the payoff this case pays out is read from the
      // quote — the same figure the prepay guard compares against — with the
      // outstanding tile standing as the on-screen proof the page is loaded.
      await expect
        .poll(() => quote(adminApi, id).then((q) => q.payoffAmount), { timeout: 15_000 })
        .toBe(600);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(600);

      // The dialog says so in as many words ("Paying the full … closes the
      // loan"), and the guard lets exactly-the-payoff through — `amount > payoff`
      // is a strict comparison on purpose.
      await detail.run('prepay', { amount: '600', mode: 'CASH' });
      await detail.expectStatus('CLOSED');

      const after = await record(adminApi, id);
      // EARLY_CLOSURE rather than MANUAL: the loan closed because it was paid,
      // not because somebody decided a residual was small enough to forgive.
      expect(after.closureType, 'a full prepayment closed the loan as something else')
        .toBe('EARLY_CLOSURE');
      expect(Number(after.amountRepaid)).toBe(600);
      expect(Number(after.waivedAmount), 'a fully paid loan forgave money as well').toBe(0);
      expect((await quote(adminApi, id)).payoffAmount).toBe(0);

      // Every still-open instalment is retired rather than left owing against a
      // loan nobody can pay any more.
      const plan = await rows(adminApi, id);
      expect(plan.some((r) => r.status === 'SCHEDULED'), 'a closed loan kept live instalments')
        .toBe(false);

      settle(problems, 'paying a loan off exactly');
    });

    test('one minor unit above the payoff is refused, quoting the payoff, without a round trip', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 300, installments: 3, note: 'a penny over' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      // Same dual-purpose tile as above: interest-free, so it shows the 100
      // instalment, not the 300 payoff the guard quotes back below.
      await expect
        .poll(() => quote(adminApi, id).then((q) => q.payoffAmount), { timeout: 15_000 })
        .toBe(300);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(300);

      const problem = await detail.attempt('prepay', { amount: '300.01', mode: 'BANK' });

      // Answered from the quote already on screen, and answered WITH the figure
      // to type instead — the operator can act on this one. The server's own
      // version of the same refusal ("exceeds the payoff amount of …") is only
      // reachable through a stale page, which is `finance-loan-lifecycle.spec.ts`'s
      // case, not this one.
      expect(problem).toBe(
        'That is more than this loan is worth. The full payoff today is 300; paying exactly that closes it.',
      );
      expect(
        problems.httpErrors.filter((line) => line.includes('/prepay')),
        'the overpayment guard let the request through to the server',
      ).toEqual([]);

      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);
      expect((await quote(adminApi, id)).outstandingPrincipal, 'the refused payment was applied')
        .toBe(300);

      settle(problems, 'a prepayment one minor unit above the payoff');
    });

    test('two prepayments in the same month both post, and both move the balance', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'two in one month' });
      await selectBranch(page, branchId);

      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(600);

      // Nothing about a prepayment is per-cycle: it is a payment, not an
      // instalment, and a second one in the same month is an ordinary event
      // (an employee clearing a loan in two transfers) rather than a duplicate.
      await detail.run('prepay', { amount: '100', mode: 'BANK', reference: `${MARKER}-utr-1` });
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(500);

      await detail.run('prepay', { amount: '100', mode: 'CASH', reference: `${MARKER}-utr-2` });
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(400);

      const after = await record(adminApi, id);
      expect(Number(after.amountRepaid), 'the second payment overwrote the first').toBe(200);
      expect(after.status, 'two part payments closed the loan').toBe('APPROVED');
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(400);

      settle(problems, 'two prepayments in one month');
    });

    test('every payment mode the DTO names is accepted, and each one moves the balance', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 400, installments: 4, note: 'modes' });
      const modes = ['CASH', 'BANK', 'CHEQUE', 'ADJUSTMENT'];

      // Driven over the API rather than through four dialogs: the claim is that
      // the DTO's `@IsIn` list and the select on screen are the same four
      // values, and the select is asserted by the cases above using two of them.
      for (const [i, mode] of modes.entries()) {
        await adminApi.post(`/advance-loans/${id}/prepay`, {
          amount: 50,
          mode,
          reference: `${MARKER}-${mode}`,
        });
        expect(
          (await quote(adminApi, id)).outstandingPrincipal,
          `a ${mode} payment did not reduce the balance`,
        ).toBe(400 - 50 * (i + 1));
      }

      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/prepay`, { amount: 10, mode: 'BARTER' }),
      );
      expect(problem, 'an invented payment mode was accepted').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/mode/i);
    });

    test('a reference of 120 characters is kept and 121 is rejected', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'reference bounds' });

      // 120 is the `@Length(1, 120)` ceiling — a cheque number or a UTR, not an
      // essay, but long enough for the bank references that actually turn up.
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 10,
        mode: 'CHEQUE',
        reference: 'r'.repeat(120),
      });
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(290);

      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/prepay`, {
          amount: 10,
          mode: 'CHEQUE',
          reference: 'r'.repeat(121),
        }),
      );
      expect(problem, 'a 121-character reference was accepted').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/reference/i);
      expect(
        (await quote(adminApi, id)).outstandingPrincipal,
        'the rejected payment was applied anyway',
      ).toBe(290);
    });

    test('an amount carrying three decimals is rejected rather than silently rounded', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'three decimals' });

      // The money columns are Decimal(12,2). A third decimal has to be refused
      // at the edge, because the alternative is a rounding nobody asked for
      // happening somewhere downstream where it cannot be seen.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/prepay`, { amount: 10.005, mode: 'BANK' }),
      );
      expect(problem, 'a 3dp amount was accepted').not.toBe('');
      expect(problem).toContain('400');
      // class-validator's own wording for a failed `@IsNumber({ maxDecimalPlaces: 2 })`.
      // It does not name the decimals; the constraint that refused it does.
      expect(problem).toMatch(/amount must be a number conforming to the specified constraints/i);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(300);
    });

    test('a zero or negative prepayment is rejected', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'non-positive' });

      for (const amount of [0, -50]) {
        const problem = await refusal(
          adminApi.post(`/advance-loans/${id}/prepay`, { amount, mode: 'BANK' }),
        );
        expect(problem, `a prepayment of ${amount} was accepted`).not.toBe('');
        expect(problem).toContain('400');
      }
      expect(
        (await quote(adminApi, id)).outstandingPrincipal,
        'a non-positive payment moved the balance',
      ).toBe(300);
    });

    test('a value date is validated for shape but not for range', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'paidOn' });

      const nextYear = new Date();
      nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
      const future = nextYear.toISOString().slice(0, 10);

      // BUG?: a prepayment can be dated a year into the future — `@IsDateString`
      // checks the shape and nothing checks the range, so the ledger can carry a
      // transaction dated after the period it is reported in.
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 10,
        mode: 'BANK',
        paidOn: future,
      });
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(290);

      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/prepay`, {
          amount: 10,
          mode: 'BANK',
          paidOn: 'the day before yesterday',
        }),
      );
      expect(problem, 'a malformed value date was accepted').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/paidOn|date/i);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(290);
    });

    test('a replayed idempotency key is refused and the money moves exactly once', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'idempotency' });

      // Driven over the API because there is nowhere else to drive it: the
      // prepayment dialog collects amount, mode, reference and recalc, and
      // sends no key at all. The protection exists for the retried REQUEST —
      // a proxy timeout, a double-submitted integration — not for a
      // double-clicked button.
      const key = randomUUID();
      const body = { amount: 30, mode: 'BANK', reference: `${MARKER}-replay`, idempotencyKey: key };

      await adminApi.post(`/advance-loans/${id}/prepay`, body);
      expect(Number((await record(adminApi, id)).amountRepaid)).toBe(30);

      const problem = await refusal(adminApi.post(`/advance-loans/${id}/prepay`, body));
      expect(problem, 'the same payment was recorded twice').not.toBe('');
      // 409, not 400: the request was well formed and would have been valid; it
      // is a duplicate, which is a different thing to tell the caller.
      expect(problem).toContain('409');
      expect(problem).toMatch(/already been recorded/i);

      const after = await record(adminApi, id);
      expect(Number(after.amountRepaid), 'the replay moved the balance a second time').toBe(30);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(270);
    });

    test('REDUCE_TENURE keeps the instalment and drops instalments off the tail', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'reduce tenure' });
      const before = await record(adminApi, id);
      expect(Number(before.installmentAmount), 'the approved loan did not amortize to 100').toBe(100);
      expect((await rows(adminApi, id)).length).toBe(6);

      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 200,
        mode: 'BANK',
        recalc: 'REDUCE_TENURE',
      });

      // 400 left at an unchanged instalment of 100 is four instalments, not six.
      await expect
        .poll(async () => (await rows(adminApi, id)).length, { timeout: 15_000 })
        .toBe(4);
      const after = await record(adminApi, id);
      expect(Number(after.installmentAmount), 'REDUCE_TENURE changed the instalment').toBe(100);
    });

    test('REDUCE_EMI keeps the instalment count and lowers each one', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'reduce emi' });
      expect((await rows(adminApi, id)).length).toBe(6);

      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 200,
        mode: 'BANK',
        recalc: 'REDUCE_EMI',
      });

      // The employee keeps the same six payslips and each one gets smaller —
      // the opposite trade to REDUCE_TENURE, and the reason both exist.
      await expect
        .poll(async () => (await rows(adminApi, id)).length, { timeout: 15_000 })
        .toBe(6);
      const after = await record(adminApi, id);
      const emi = Number(after.installmentAmount);
      expect(emi, 'REDUCE_EMI left the instalment where it was').toBeLessThan(100);
      expect(emi).toBeGreaterThan(0);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(400);
    });

    test('a held loan offers no prepayment, and the server refuses one too', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'held' });
      await adminApi.post(`/advance-loans/${id}/hold`, {
        reason: `${MARKER} paused before the journey`,
      });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('ON_HOLD');

      // `loanGuards.ts` carries the sentence for this case — "Recovery is paused
      // on this loan. Resume it before recording payments or changing the
      // schedule." The panel does not draw the button that would open the
      // dialog that would show it, so the sentence is still unreachable from
      // the SCREEN — but the hidden button is no longer the whole enforcement.
      // The server says the same thing now, in the same words.
      expect(await detail.offers('prepay'), 'a paused loan offered a prepayment').toBe(false);
      expect(await detail.offers('skip'), 'a paused loan offered a schedule change').toBe(false);
      expect(await detail.hasHoldBanner(), 'a held loan showed no explanation').toBe(true);

      // `assertActive` used to treat ON_HOLD as live, so the guard's promise
      // held only for as long as nobody called the endpoint directly. The
      // server enforces it for prepay, skip-installment and a second hold —
      // and only those three, the ones the guard actually names.
      await expect(
        adminApi.post(`/advance-loans/${id}/prepay`, { amount: 50, mode: 'CASH' }),
        'the server took a payment on a loan whose recovery is paused',
      ).rejects.toThrow(
        /400[\s\S]*Recovery is paused on this loan\. Resume it before recording payments or changing the schedule\./,
      );
      await expect(
        adminApi.post(`/advance-loans/${id}/skip-installment`, {
          installmentNo: 2,
          mode: 'FORGIVE',
          reason: `${MARKER} a schedule change while paused`,
        }),
      ).rejects.toThrow(/400[\s\S]*Recovery is paused on this loan/);

      const after = await record(adminApi, id);
      expect(Number(after.amountRepaid), 'a refused payment still moved the balance').toBe(0);
      expect(after.status).toBe('ON_HOLD');

      // Resuming is the way out, and it still works on a held loan — a blanket
      // rejection would have locked the loan up entirely.
      await adminApi.post(`/advance-loans/${id}/resume`, { reason: `${MARKER} released` });
      expect((await record(adminApi, id)).status).toBe('ACTIVE');

      settle(problems, 'a held loan and its prepayment');
    });

    test('a request still awaiting approval offers no operations and is refused by name', async ({
      page,
      problems,
    }) => {
      // Filed and NOT approved: `liveLoan` is deliberately not used here.
      const created = await ownerApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 300,
        installments: 3,
        reason: `${MARKER} — filed but not decided`,
      });
      scratch.push(created.id);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(created.id);
      await detail.expectStatus('PENDING');

      // No empty bordered box: the panel is replaced by the reason it is empty,
      // carrying the status it was written for.
      expect(await detail.operations(), 'an undecided request offered money operations').toEqual([]);
      const reason = await detail.noActionsReason();
      expect(reason?.status).toBe('PENDING');
      expect(reason?.text.length, 'the empty panel explained nothing').toBeGreaterThan(0);

      const problem = await refusal(
        adminApi.post(`/advance-loans/${created.id}/prepay`, { amount: 10, mode: 'CASH' }),
      );
      expect(problem, 'an undecided request accepted a payment').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/not been approved yet/i);

      settle(problems, 'a request that has not been decided');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §8 Closure — the manual close and its tolerance
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('a manual close', () => {
    test('a residual above the tolerance is refused, naming the balance and the tolerance', async ({
      page,
      problems,
    }) => {
      crashesOnly(problems);
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const residual = Number((tolerance + 2).toFixed(2));
      const id = await track({ amount: 600, installments: 6, note: 'residual above tolerance' });
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: Number((600 - residual).toFixed(2)),
        mode: 'BANK',
      });
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(residual);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      // `loanGuards.ts` deliberately does NOT pre-check this one: the threshold
      // is a setting the client cannot see, and a guessed client copy would
      // refuse closes the server would allow the moment an admin raised it. So
      // the refusal has to travel — and has to arrive with both numbers in it,
      // because "too much is outstanding" without saying how much or how much
      // would have been little enough is not actionable.
      const problem = await detail.attempt('close', {
        reason: `${MARKER} closing over the tolerance`,
      });

      expect(problem).toContain(`Outstanding balance is ${residual}`);
      expect(problem).toContain(`rounding tolerance of ${tolerance}`);
      expect(problem).toMatch(/prepay, waive or write-off/i);

      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);
      expect((await record(adminApi, id)).status, 'a refused close closed the loan').toBe('APPROVED');

      settle(problems, 'closing a loan whose residual is above the tolerance');
    });

    test('a residual sitting exactly on the tolerance closes, as a manual closure', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 600, installments: 6, note: 'residual at tolerance' });
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: Number((600 - tolerance).toFixed(2)),
        mode: 'BANK',
      });
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(tolerance);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);

      // The comparison is `residual > tolerance`, so the boundary itself is
      // INSIDE. That is the case the tolerance exists for — an EMI that
      // rounded to the unit and left the last cent behind.
      await detail.run('close', { reason: `${MARKER} residual exactly on the tolerance` });
      await detail.expectStatus('CLOSED');

      const after = await record(adminApi, id);
      // MANUAL, not EARLY_CLOSURE: nobody paid this last piece, it was written
      // off as a rounding adjustment — and the waived counter is where that
      // shows, which is what keeps the ledger honest about it.
      expect(after.closureType).toBe('MANUAL');
      expect(Number(after.waivedAmount), 'the forgiven residual was not recorded').toBe(tolerance);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(0);

      settle(problems, 'closing a loan sitting exactly on the tolerance');
    });

    test('a reason under five characters is refused by the server', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'thin close reason' });

      // Over the API on purpose: `loanGuards.ts` stops a four-character reason
      // in the browser, so the SERVER's own `@Length(5, 500)` would never be
      // exercised from a screen — and it is the one that actually protects the
      // audit trail.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/close`, { reason: 'meh' }),
      );
      expect(problem, 'a three-character closure reason was accepted').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/reason/i);
      expect((await record(adminApi, id)).status).toBe('APPROVED');
    });

    test('a loan against which no instalment has yet run cannot be closed', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'fresh close' });

      // The whole principal is a residual only in the sense that it is what is
      // left. Closing here would forgive 600 through the door marked "rounding".
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/close`, {
          reason: `${MARKER} closing a loan nobody has paid`,
        }),
      );
      expect(problem, 'an untouched loan closed as a rounding adjustment').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toContain('Outstanding balance is 600');

      const after = await record(adminApi, id);
      expect(after.status).toBe('APPROVED');
      expect(Number(after.waivedAmount), 'the refused close forgave money anyway').toBe(0);
    });

    test('a payroll run holding an instalment for the loan blocks the close', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'payroll in flight' });
      const subject = (await record(adminApi, id)).employeeId;

      // A run is generated for a whole BRANCH and the recovery planner sweeps
      // arrears forward, so an untargeted one would attach a PENDING instalment
      // to every live loan in the branch — including whatever the other finance
      // specs are halfway through. `employeeIds` narrows it to this file's own
      // requester, and the period is seven years out, so the blast radius is one
      // employee in a month nobody else runs. It is still cleared in `finally`.
      const period = { month: 9, year: new Date().getUTCFullYear() + 7 };
      let payrollId = '';
      try {
        await clearPayrolls(adminApi, branchId, period.month, period.year);
        const run = await runPayroll(adminApi, {
          ...period,
          branchId,
          employeeIds: [subject],
        }).catch(() => null);
        test.skip(!run, 'no payroll run could be generated for this period');
        payrollId = run!.id;

        // The seeded accounts are all on `baseSalary: 0`, and a zero-net cycle
        // recovers nothing — the planner writes the ledger row as SKIPPED rather
        // than PENDING, and only a PENDING row in an unlocked run is what
        // `assertNoRunInFlight` refuses on. So the case states what it needs and
        // skips when the environment cannot supply it, rather than passing for
        // the wrong reason.
        const held = (await deductionsFor(adminApi, id)) as Array<{ status: string }>;
        test.skip(
          !held.some((d) => d.status === 'PENDING'),
          'the run took no instalment for this loan — the seeded requester is paid 0, ' +
            'so the deduction was written SKIPPED and nothing is in flight to protect',
        );

        const problem = await refusal(
          adminApi.post(`/advance-loans/${id}/close`, {
            reason: `${MARKER} closing under a live payroll run`,
          }),
        );
        expect(problem, 'a loan inside an unlocked payroll was closed anyway').not.toBe('');
        // 409, not 400: the request is valid, the ground is simply moving. The
        // sentence says which run and what to do about it, because "try again
        // later" is not something an operator can act on.
        expect(problem).toContain('409');
        expect(problem).toContain(`Payroll ${period.month}/${period.year} is in progress`);
        expect(problem).toMatch(/Lock or delete that run first/i);

        expect((await record(adminApi, id)).status).toBe('APPROVED');
      } finally {
        // `runPayroll` and `clearPayrolls` both MUTATE the admin client's branch
        // header, and everything after this case wants the company-wide view
        // back.
        if (payrollId) await deletePayroll(adminApi, payrollId).catch(() => undefined);
        adminApi.withBranch(null);
      }
    });
  });

  test.describe('the rounding tolerance itself', () => {
    test.beforeEach(() => {
      test.skip(
        !flagFlipAllowed(),
        'flips `loan_rounding_tolerance`, an environment-wide setting; run with E2E_ALLOW_FLAG_FLIP=1',
      );
    });

    test('raising it lets a bigger residual close', async ({ page, problems }) => {
      const id = await track({ amount: 600, installments: 6, note: 'raised tolerance' });
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 590, mode: 'BANK' });
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(10);

      await withSetting(adminApi, 'loan_rounding_tolerance', '25.00', async () => {
        await selectBranch(page, branchId);
        const detail = new LoanLifecyclePage(page);
        await detail.open(id);

        // The same 10 that the default 1.00 would have refused. This is the
        // reason the client does not carry its own copy of the threshold: the
        // rule is a number in a table, and it moves.
        await detail.run('close', { reason: `${MARKER} residual under the raised tolerance` });
        await detail.expectStatus('CLOSED');

        const after = await record(adminApi, id);
        expect(after.closureType).toBe('MANUAL');
        expect(Number(after.waivedAmount)).toBe(10);
      });

      settle(problems, 'closing under a raised rounding tolerance');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §8 Closure — foreclosure
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('foreclosure', () => {
    test('is neither offered nor accepted while principal remains', async ({ page, problems }) => {
      const id = await track({ amount: 600, installments: 6, note: 'foreclose too early' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('APPROVED');

      // The screen half: no button, because one that always answered 400 would
      // be worse than none.
      expect(await detail.offers('foreclose'), 'foreclose was offered on a loan with a balance')
        .toBe(false);

      // The rule half: hiding a button is a UI decision, and without this the
      // gate would be one `curl` away from irrelevant. The sentence names the
      // balance and the two ways out, which is what makes it usable.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/foreclose`, {
          reason: `${MARKER} foreclosing a loan that is still owed`,
        }),
      );
      expect(problem, 'a loan with a full balance was foreclosed').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toContain('This loan still has 600 of principal outstanding');
      expect(problem).toMatch(/write-off\/waive/i);

      expect((await record(adminApi, id)).status).toBe('APPROVED');

      settle(problems, 'foreclosing a loan that still owes principal');
    });

    test('closes a cleared loan as FORECLOSED, whether or not future interest is waived', async ({
      page,
      problems,
    }) => {
      // Forgiving the sole instalment is the one route that empties the
      // principal WITHOUT closing the loan, which is precisely the state
      // foreclosure exists for.
      const waived = await track({ amount: 300, installments: 1, note: 'foreclose waiving' });
      await adminApi.post(`/advance-loans/${waived}/skip-installment`, {
        installmentNo: 1,
        mode: 'FORGIVE',
        reason: `${MARKER} sole instalment forgiven`,
      });
      expect((await quote(adminApi, waived)).outstandingPrincipal).toBe(0);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(waived);
      await detail.expectStatus('APPROVED');
      expect(await detail.offers('foreclose'), 'a cleared loan was not offered foreclosure')
        .toBe(true);

      await detail.run('foreclose', {
        waive: 'yes',
        reason: `${MARKER} closing a cleared loan, waiving what is left`,
      });
      await detail.expectStatus('CLOSED');

      const withWaiver = await record(adminApi, waived);
      expect(withWaiver.closureType).toBe('FORECLOSED');
      // The WAIVER transaction is booked only when interest actually remains,
      // and `loan_interest_enabled` is pinned FALSE by the e2e baseline — so a
      // loan filed through the request form can never carry any. The waived
      // counter therefore holds the 300 the forgiven instalment put there and
      // nothing more: `waiveFutureInterest` had nothing to waive.
      expect(Number(withWaiver.waivedAmount)).toBe(300);

      // The other half of the same switch, over the API so the pair is compared
      // rather than assumed.
      const kept = await track({ amount: 300, installments: 1, note: 'foreclose keeping' });
      await adminApi.post(`/advance-loans/${kept}/skip-installment`, {
        installmentNo: 1,
        mode: 'FORGIVE',
        reason: `${MARKER} sole instalment forgiven`,
      });
      await adminApi.post(`/advance-loans/${kept}/foreclose`, {
        waiveFutureInterest: false,
        reason: `${MARKER} closing a cleared loan, interest still payable`,
      });

      const withoutWaiver = await record(adminApi, kept);
      expect(withoutWaiver.status).toBe('CLOSED');
      expect(withoutWaiver.closureType).toBe('FORECLOSED');
      expect(
        Number(withoutWaiver.waivedAmount),
        'declining the interest waiver still forgave money',
      ).toBe(300);

      settle(problems, 'foreclosing a cleared loan');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §8 Closure — waiver
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('a waiver', () => {
    test('takes its amount from the balance the waiveType names', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'waive types' });

      // INTEREST first, because it is the one with nothing behind it:
      // `loan_interest_enabled` is pinned FALSE by the e2e baseline, so a loan
      // filed through the request form carries no interest at all, the cap is 0,
      // and a blank amount resolves to 0. The refusal is therefore the CORRECT
      // answer here and not a missing feature — but it is worth pinning, because
      // "waive the interest" silently forgiving principal instead would be a
      // very quiet way to lose money.
      const interest = await refusal(
        adminApi.post(`/advance-loans/${id}/waive`, {
          waiveType: 'INTEREST',
          reason: `${MARKER} waiving interest that does not exist`,
        }),
      );
      expect(interest, 'an interest waiver on a zero-interest loan went through').not.toBe('');
      expect(interest).toContain('400');
      expect(interest).toMatch(/greater than 0/i);

      await adminApi.post(`/advance-loans/${id}/waive`, {
        waiveType: 'PRINCIPAL',
        amount: 100,
        reason: `${MARKER} hardship write-down against principal`,
      });
      let after = await record(adminApi, id);
      expect(Number(after.waivedAmount)).toBe(100);
      expect(after.status, 'a part waiver closed the loan').toBe('APPROVED');
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(500);

      // BOTH is the default, and with no interest to take first it lands on
      // principal too — so the two counters must agree rather than double-count.
      await adminApi.post(`/advance-loans/${id}/waive`, {
        waiveType: 'BOTH',
        amount: 100,
        reason: `${MARKER} second tranche of the same write-down`,
      });
      after = await record(adminApi, id);
      expect(Number(after.waivedAmount)).toBe(200);
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(400);
    });

    test('an amount above the balance it is aimed at is refused before it is sent', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 300, installments: 3, note: 'waive over cap' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(300);

      const problem = await detail.attempt('waive', {
        'waive-type': 'PRINCIPAL',
        amount: '500',
        reason: `${MARKER} waiving more than is owed`,
      });

      // Answered from the quote on screen, and answered with the cap — which is
      // the number the operator has to type instead.
      expect(problem).toBe('A waiver of 500 is more than the principal balance of 300.');
      expect(
        problems.httpErrors.filter((line) => line.includes('/waive')),
        'the over-cap guard let the request through to the server',
      ).toEqual([]);
      expect(await detail.modalOpen(), 'a refused operation closed its own dialog').toBe(true);

      settle(problems, 'a waiver larger than the balance');
    });

    test('a blank amount is capped at the balance and closes the loan, an explicit one is refused', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'waive cap' });

      // BUG?: the catalogue expects an over-cap waiver to be CAPPED at the
      // balance; the service rejects it outright instead, and only a BLANK
      // amount is capped. Refusing is arguably the better behaviour — silently
      // forgiving less than was asked for is how a write-down gets signed off at
      // the wrong figure — but the two are not the same rule and this is the one
      // that ships.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/waive`, {
          waiveType: 'PRINCIPAL',
          amount: 500,
          reason: `${MARKER} waiving more than is owed`,
        }),
      );
      expect(problem, 'an over-cap waiver was accepted').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toContain('Waiver of 500 exceeds the principal balance of 300');
      expect(Number((await record(adminApi, id)).waivedAmount)).toBe(0);

      // Blank means "all of it", and the server resolves that to the cap rather
      // than trusting a number the client worked out.
      await adminApi.post(`/advance-loans/${id}/waive`, {
        waiveType: 'PRINCIPAL',
        reason: `${MARKER} writing the balance down in full`,
      });

      const after = await record(adminApi, id);
      expect(Number(after.waivedAmount), 'the blank amount did not resolve to the balance').toBe(300);
      expect(after.status).toBe('CLOSED');
      expect(after.closureType).toBe('WAIVER');
      expect((await quote(adminApi, id)).outstandingPrincipal).toBe(0);
    });
  });

  test.describe('who may waive', () => {
    test.beforeEach(() => {
      test.skip(
        !flagFlipAllowed(),
        'flips `loan_waiver_roles`, an environment-wide setting; run with E2E_ALLOW_FLAG_FLIP=1',
      );
    });

    test('narrowing loan_waiver_roles to ADMIN refuses the HR manager the route still admits', async () => {
      const id = await track({ amount: 400, installments: 4, note: 'waiver role gate' });
      const hrApi = await ApiClient.as('hr');

      try {
        // The baseline pins `ADMIN,HR_MANAGER`, so HR can waive by default —
        // `finance-loan-lifecycle.spec.ts` asserts the button is there. The
        // claim here is that the SETTING is what decides it, not the
        // `@Roles('ADMIN','HR_MANAGER')` decorator on the route, which never
        // changes.
        await withSetting(adminApi, 'loan_waiver_roles', 'ADMIN', async () => {
          const problem = await refusal(
            hrApi.post(`/advance-loans/${id}/waive`, {
              waiveType: 'PRINCIPAL',
              amount: 50,
              reason: `${MARKER} waiving as HR while the setting says ADMIN`,
            }),
          );
          expect(problem, 'HR waived while the setting named ADMIN alone').not.toBe('');
          expect(problem).toContain('403');
          expect(problem).toMatch(/not permitted/i);

          const after = await record(adminApi, id);
          expect(Number(after.waivedAmount), 'the refused waiver forgave money anyway').toBe(0);
        });
      } finally {
        await hrApi.dispose();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §8 Closure — write-off and reinstatement
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('a write-off', () => {
    test('part of a balance leaves the loan live; the rest of it ends the loan', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 400, installments: 4, note: 'partial write-off' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('APPROVED');

      // A partial write-off is a decision about part of the debt, not about the
      // loan: the employee still owes the rest and payroll must keep collecting
      // it, so nothing about the status or the panel may change.
      await detail.run('writeOff', { amount: '100', reason: AUDITED });
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(300);

      const partial = await record(adminApi, id);
      expect(partial.status, 'writing off part of a balance closed the loan').toBe('APPROVED');
      expect(Number(partial.writtenOffAmount)).toBe(100);
      expect(partial.closureType, 'a live loan was given a closure type').toBeFalsy();
      expect(await detail.offers('writeOff'), 'a part-written-off loan refused the rest').toBe(true);

      // Blank means the whole remaining balance, and now the loan is over.
      await detail.run('writeOff', { reason: AUDITED });
      await detail.expectStatus('WRITTEN_OFF');

      const full = await record(adminApi, id);
      expect(Number(full.writtenOffAmount), 'the two write-offs did not add up').toBe(400);
      expect(full.closureType).toBe('WRITE_OFF');

      // The schedule is marked rather than deleted: an instalment nobody will
      // ever collect must still be visible as one that was forgiven.
      await expect
        .poll(() => detail.scheduleRowStatus(1), { timeout: 15_000 })
        .toBe('WRITTEN_OFF');
      expect(
        (await rows(adminApi, id)).every((r) => r.status === 'WRITTEN_OFF'),
        'a written-off loan kept live instalments',
      ).toBe(true);

      // Not simply "finished": the one thing still possible is putting the money
      // back, and the panel must offer that and nothing else.
      await expect.poll(() => detail.operations(), { timeout: 15_000 }).toEqual(['reinstate']);

      settle(problems, 'writing off part of a balance and then the rest');
    });

    test('a nine-character reason is refused in the browser and a ten-character one is not', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 400, installments: 4, note: 'write-off reason floor' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('APPROVED');

      // Nine, not "short": the server's floor is `@Length(10, 500)` and the
      // interesting question is whether the client's copy of it sits on the same
      // number. A guard that refused at 20 would look identical from a test that
      // typed "short".
      const problem = await detail.attempt('writeOff', { reason: '123456789' });
      expect(problem).toBe(
        'A write-off needs a reason of at least 10 characters — it permanently forgives company money and is audited.',
      );
      expect(
        problems.httpErrors.filter((line) => line.includes('write-off')),
        'the reason-length guard let the request through to the server',
      ).toEqual([]);

      // The dialog stayed open carrying what was typed, so the fix is one field
      // away rather than a retyped form — and the tenth character is enough.
      await detail.fill({ reason: '0123456789' });
      await detail.confirm();
      await detail.expectStatus('WRITTEN_OFF');

      const after = await record(adminApi, id);
      expect(Number(after.writtenOffAmount)).toBe(400);
      expect(after.closureType).toBe('WRITE_OFF');

      settle(problems, 'the write-off reason floor');
    });

    test('an amount above the outstanding balance is refused by both layers', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 400, installments: 4, note: 'write-off over balance' });

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(400);

      const problem = await detail.attempt('writeOff', { amount: '500', reason: AUDITED });
      expect(problem).toBe('A write-off of 500 is more than the 400 outstanding on this loan.');
      expect(
        problems.httpErrors.filter((line) => line.includes('write-off')),
        'the over-balance guard let the request through to the server',
      ).toEqual([]);
      await detail.cancelOp();

      // And the server says the same thing in its own words, so removing the
      // client copy would cost a round trip and nothing else.
      const server = await refusal(
        adminApi.post(`/advance-loans/${id}/write-off`, { amount: 500, reason: AUDITED }),
      );
      expect(server, 'the server wrote off more than was owed').not.toBe('');
      expect(server).toContain('400');
      expect(server).toContain('Write-off of 500 exceeds the outstanding balance of 400');

      const after = await record(adminApi, id);
      expect(after.status).toBe('APPROVED');
      expect(Number(after.writtenOffAmount)).toBe(0);

      settle(problems, 'a write-off larger than the balance');
    });
  });

  test.describe('reinstating', () => {
    test('puts the balance back and rebuilds the schedule over the same instalment count', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 400, installments: 4, note: 'reinstate schedule' });
      expect((await rows(adminApi, id)).length).toBe(4);

      await adminApi.post(`/advance-loans/${id}/write-off`, { reason: AUDITED });
      expect(
        (await rows(adminApi, id)).every((r) => r.status === 'WRITTEN_OFF'),
        'the write-off left instalments live',
      ).toBe(true);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('WRITTEN_OFF');

      await detail.run('reinstate', {
        reason: `${MARKER} employee returned and agreed a repayment plan`,
      });
      await detail.expectStatus('ACTIVE');

      const after = await record(adminApi, id);
      expect(Number(after.writtenOffAmount), 'the write-off survived its own reversal').toBe(0);
      expect((await quote(adminApi, id)).payoffAmount, 'the payoff quote was not restored').toBe(400);

      // The count is the part that matters, and it is why `reinstate` clears the
      // forgiven rows before regenerating: `regenerate` treats a WRITTEN_OFF row
      // as settled, so left alone a reinstated loan has "0 instalments
      // remaining" and collapses into one lump sum due next cycle — the employee
      // would owe the whole balance in a single payslip.
      await expect
        .poll(() => detail.scheduleRowCount(), { timeout: 15_000 })
        .toBe(4);
      const plan = await rows(adminApi, id);
      expect(plan.length).toBe(4);
      expect(
        plan.every((r) => r.status === 'SCHEDULED'),
        'the rebuilt schedule came back already settled',
      ).toBe(true);

      settle(problems, 'reinstating a written-off loan');
    });

    test('a loan that was never written off has nothing to reinstate', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'reinstate nothing' });

      // Unreachable from the screen — the button is drawn only for WRITTEN_OFF —
      // so the rule lives here or nowhere.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${id}/reinstate`, {
          reason: `${MARKER} reinstating a loan nobody wrote off`,
        }),
      );
      expect(problem, 'a live loan was reinstated').not.toBe('');
      expect(problem).toContain('400');
      expect(problem).toMatch(/nothing written off to reinstate/i);
      expect((await record(adminApi, id)).status).toBe('APPROVED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The terminal guard
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('a closed loan', () => {
    test('offers nothing at all, and says why instead of showing an empty box', async ({
      page,
      problems,
    }) => {
      const id = await track({ amount: 300, installments: 3, note: 'terminal panel' });
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 300, mode: 'BANK' });
      expect((await record(adminApi, id)).status).toBe('CLOSED');

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await detail.expectStatus('CLOSED');

      expect(await detail.operations(), 'a settled loan offered money operations').toEqual([]);
      const reason = await detail.noActionsReason();
      expect(reason?.status, 'the explanation was not written for this status').toBe('CLOSED');
      expect(reason?.text.length, 'the empty panel explained nothing').toBeGreaterThan(0);

      // The schedule and the ledger stay on screen: a settled loan is a record,
      // not a blank page.
      expect(await detail.summary('repaid')).toBe(300);
      expect(await detail.summary('outstanding')).toBe(0);

      settle(problems, 'the panel on a settled loan');
    });

    test('refuses every one of the ten operations when asked directly', async () => {
      const id = await track({ amount: 300, installments: 3, note: 'terminal sweep' });
      await adminApi.post(`/advance-loans/${id}/prepay`, { amount: 300, mode: 'BANK' });
      expect((await record(adminApi, id)).status).toBe('CLOSED');

      // A hidden button is a UI decision. Without this the terminal guard would
      // be one `curl` away from irrelevant — and "no further money moves against
      // a settled loan" is the invariant the whole ledger rests on.
      for (const op of ALL_OPS) {
        const { path, body } = OP_CALL[op];
        const problem = await refusal(adminApi.post(`/advance-loans/${id}/${path}`, body));
        expect(problem, `${op} was accepted on a CLOSED loan`).not.toBe('');
        expect(problem, `${op} failed with something other than a refusal`).toMatch(/failed: 4\d\d/);
      }

      const after = await record(adminApi, id);
      expect(after.status).toBe('CLOSED');
      expect(after.closureType).toBe('EARLY_CLOSURE');
      expect(Number(after.amountRepaid)).toBe(300);
      expect(Number(after.waivedAmount)).toBe(0);
      expect(Number(after.writtenOffAmount)).toBe(0);
    });
  });
});
