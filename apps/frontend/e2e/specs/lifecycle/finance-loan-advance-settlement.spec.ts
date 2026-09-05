import { test, expect, settle, ApiClient } from '../../fixtures';
import { ClearanceBannerPanel, TerminationsPage } from '../../pages';
import { LoanLifecyclePage, selectBranch } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  flagFlipAllowed,
  liveLoan,
  loanOf,
  makeEmployee,
  marker,
  quoteOf,
  retire,
  retireAllMarked,
  scheduleOf,
  terminateEmployee,
  TestEmployee,
  withSetting,
} from '../../loan-support';

/**
 * Salary advances, conversion past the point the lifecycle journey stops, and
 * the whole of exit settlement.
 *
 * ## Why this file is mostly HTTP
 *
 * Settlement has **no user interface at all**. `/advance-loans/settlement/*` is
 * three routes and nothing renders them: there is no settlement screen, no
 * settlement modal, and no link to one. Two of the thirteen loan statuses —
 * `SETTLED` and `RECEIVABLE` — are therefore reachable ONLY over HTTP, which
 * means a browser-driven spec could not put a loan into either of them, let
 * alone assert what happens next.
 *
 * So the cases below are API cases by necessity rather than by preference, and
 * the browser appears exactly twice, in the two places where a settled loan is
 * genuinely visible to a human:
 *
 *   • the loan DETAIL route, which draws the badge and — for a status with no
 *     operations left — the sentence explaining why the Actions panel is empty;
 *   • the offboarding CLEARANCE banner inside a termination request, which is
 *     the one screen that tells an approver a loan balance is what is blocking
 *     them.
 *
 * That split is deliberate and is the finding in itself: `RECEIVABLE` is a
 * decision an operator can only make with `curl`.
 *
 * ## Why almost every case owns its employee
 *
 * `settle()` refuses unless EVERY non-terminal loan the employee holds is named
 * in the decision list. Run against a shared seeded account, that turns any
 * loan another spec happens to be halfway through into a fixture this file has
 * to make a decision about — and making one would destroy the other spec's
 * subject. So each settlement describe hires its own people through
 * `makeEmployee()` and never touches `EMP001` / `EMP002`.
 *
 * `makeEmployee` cannot hand back a logged-in client (see `NO_LOGIN` in
 * `loan-support.ts`: `POST /employees` mints a random password it never
 * returns), and `POST /advance-loans` files for `user.employeeId` only — there
 * is no on-behalf create route. The way to give an employee-without-a-session a
 * live loan is therefore the IMPORTER, which takes an employee CODE and is an
 * ADMIN route: `importLoan` below. Imported loans arrive `ACTIVE`, with a
 * schedule and a DISBURSEMENT transaction, which is exactly the shape
 * settlement expects.
 *
 * The advance and conversion halves do use `EMP001`, because those two flows
 * start at "somebody files a request" and that step needs a session. They keep
 * the same allowance discipline as `finance-loan-lifecycle.spec.ts`.
 *
 * ## The salary ceiling that cannot be reached from here
 *
 * `advance_max_percent_of_salary` and the `NET_PAY_AFTER_EMI` eligibility rule
 * are both guarded on `monthlyNet > 0`, and EVERY seeded account that can log
 * in carries `baseSalary: 0` with no salary components — `seed.ts` sets the four
 * role accounts to 0 explicitly, and `EMP002` is seeded at 0 too. The employees
 * `makeEmployee` creates DO have a salary, and cannot file a request. So the two
 * ceiling cases below assert what the server does today for a requester with no
 * pay on record, which is: nothing. Both carry a `BUG?` line.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half — what identifies a record as THIS FILE'S, across runs. */
const MARKER_PREFIX = 'pw-loansettle-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const mark = marker(MARKER_PREFIX);

/** Unique per imported loan; the importer rejects a duplicate reference. */
let refSeq = 0;

// ───────────────────────────────────────────────────────────────────────────
// Shapes, exactly as the settlement service builds them
// ───────────────────────────────────────────────────────────────────────────

/** One row of `GET /advance-loans/settlement/:employeeId`. */
interface QuoteItem {
  loanId: string;
  type: string;
  referenceNo: string | null;
  status: string;
  principal: number;
  interest: number;
  total: number;
}

interface SettlementQuote {
  employeeId: string;
  loans: QuoteItem[];
  totalOutstanding: number;
  cleared: boolean;
}

/** The `data` half of what `POST /advance-loans/settlement/:employeeId` returns. */
interface SettleResult {
  settlementId: string;
  recovered: number;
  waived: number;
  writtenOff: number;
  carried: number;
}

type SettlementAction =
  | 'RECOVER_FROM_FINAL_PAY'
  | 'RECOVER_FROM_GRATUITY'
  | 'RECOVER_FROM_LEAVE_ENCASHMENT'
  | 'PARTIAL'
  | 'WAIVE'
  | 'WRITE_OFF'
  | 'CARRY_AS_RECEIVABLE';

interface Decision {
  loanId: string;
  action: SettlementAction | string;
  amount?: number;
  reference?: string;
  reason?: string;
}

/** One loan on `GET /advance-loans/reports/employee/:id/statement`. */
interface StatementLoan {
  id: string;
  type: string;
  status: string;
  transactions: Array<{ type: string; amount: string | number; narration: string | null }>;
}

/** The eligibility what-if, which is also the rule `create` enforces. */
interface EligibilityResult {
  eligible: boolean;
  monthlyNet: number;
  checks: Array<{ code: string; status: 'PASS' | 'FAIL' | 'WARN'; detail?: string }>;
}

// ───────────────────────────────────────────────────────────────────────────
// The three settlement routes, and the sentence a refusal comes back with
// ───────────────────────────────────────────────────────────────────────────

const quoteFor = (api: ApiClient, employeeId: string): Promise<SettlementQuote> =>
  api.get<SettlementQuote>(`/advance-loans/settlement/${employeeId}`);

const settleFor = (
  api: ApiClient,
  employeeId: string,
  decisions: Decision[],
  reason?: string,
): Promise<SettleResult> =>
  api.post<SettleResult>(`/advance-loans/settlement/${employeeId}`, { decisions, reason });

const reverseSettlement = (api: ApiClient, settlementId: string, reason: string) =>
  api.post<{ success?: boolean; message?: string }>(
    `/advance-loans/settlement/${settlementId}/reverse`,
    { reason },
  );

const receivableBook = (api: ApiClient) =>
  api.get<Array<{ id: string; status: string; employee?: { id: string } }>>(
    '/advance-loans/settlement/receivable',
  );

/**
 * The refusal, as a string, or a failure saying the call went through.
 *
 * `ApiClient` throws `"<METHOD> <path> failed: <status> <body>"` on any non-2xx,
 * so one assertion can name BOTH the status code and the server's own sentence.
 * That pairing is the point: a 400 that says the right thing and a 400 that says
 * "Bad Request" are different outcomes, and only one of them is usable.
 */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('the request was expected to be refused, but the server accepted it');
}

// ───────────────────────────────────────────────────────────────────────────
// Giving an employee-without-a-session a live loan
// ───────────────────────────────────────────────────────────────────────────

/** Today, which is never in the future and never before a 2020 start date. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A deduction period far enough out that no other spec's payroll run sweeps it.
 *
 * The recovery planner picks up arrears with `dueCycleKey <= cycleKey`, so a
 * loan whose first instalment is due in the past is attached to any run any
 * spec generates for any later period — and once an UNLOCKED run holds a PENDING
 * instalment, `assertNoRunInFlight` refuses every lifecycle operation on the
 * loan, waive and write-off included. Dating the plan well beyond anything the
 * suite generates keeps these loans out of that fight.
 */
const FIRST_DEDUCTION_PERIOD = '2039-01';

/**
 * Creates a live loan for an employee nobody can log in as.
 *
 * `POST /advance-loans/import/confirm` is the only route that takes an employee
 * CODE rather than a session, and it does NOT re-validate — `preview` owns
 * validation, `confirm` owns creation — so the row can be posted as JSON without
 * building a workbook. What it produces is a real loan: `ACTIVE`, with an
 * amortization schedule and a DISBURSEMENT transaction.
 *
 * `notes` becomes the loan's `reason` (`row.notes || 'Imported'`), which is the
 * only field `retireAllMarked` can identify this file's records by — so the
 * marker goes there.
 */
async function importLoan(
  admin: ApiClient,
  opts: {
    code: string;
    amount: number;
    installments?: number;
    type?: 'ADVANCE' | 'LOAN';
    status?: 'ACTIVE' | 'ON_HOLD';
    note: string;
  },
): Promise<string> {
  const type = opts.type ?? 'LOAN';
  const installments = type === 'ADVANCE' ? 1 : (opts.installments ?? 4);
  const referenceNo = `${mark}-${(refSeq += 1)}`.toUpperCase().replace(/[^A-Z0-9/_-]/g, '-');

  const res = await admin.post<{
    summary: { imported: number; failed: number };
    results: Array<{ referenceNo: string; success: boolean; loanId?: string; error?: string }>;
  }>('/advance-loans/import/confirm', {
    rows: [
      {
        employeeCode: opts.code,
        referenceNo,
        type,
        principal: opts.amount,
        interestMethod: 'NONE',
        interestRate: 0,
        installments,
        emi: null,
        disbursedOn: today(),
        firstDeductionPeriod: FIRST_DEDUCTION_PERIOD,
        installmentsPaid: 0,
        amountRepaid: 0,
        status: opts.status ?? 'ACTIVE',
        notes: `${mark} — ${opts.note}`,
      },
    ],
  });

  const row = res.results?.[0];
  if (!row?.success || !row.loanId) {
    throw new Error(`the importer created no loan for ${opts.code}: ${row?.error ?? 'no result row'}`);
  }
  return row.loanId;
}

/** `loanOf` returns an open record; these read one field out of it as a number. */
const numOf = (loan: Record<string, unknown>, key: string): number => Number(loan[key] ?? 0);
const strOf = (loan: Record<string, unknown>, key: string): string => String(loan[key] ?? '');

// ═══════════════════════════════════════════════════════════════════════════
// §7 — Salary advances
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An advance is not a small loan; it is a different instrument.
 *
 * The engine says so in one line: on approval, `applyApproved` sets
 * `installments = 1` and `installmentAmount = amount` for an ADVANCE before it
 * looks at anything the approver typed. Everything in this describe follows from
 * that — a single schedule row, a single recovery cycle, and a conversion route
 * for the cases where one cycle is not affordable.
 */
test.describe('a salary advance is a one-cycle instrument', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  const track = async (id: string): Promise<string> => {
    scratch.push(id);
    return id;
  };

  /** Files and approves an ADVANCE, controlling what the approver sends. */
  const advance = async (amount: number, note: string, approveWith?: number): Promise<string> => {
    const created = await employeeApi.post<{ id: string }>('/advance-loans', {
      type: 'ADVANCE',
      amount,
      reason: `${mark} — ${note}`,
    });
    await track(created.id);
    await adminApi.post(`/advance-loans/${created.id}/approve`, {
      remarks: `${mark} approved`,
      ...(approveWith === undefined ? {} : { installments: approveWith }),
    });
    return created.id;
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
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'approving an advance is an ADMIN/HR surface');
    });

    test('an advance is forced to one instalment however many the approver asks for', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The approver is deliberately sending SIX. `applyApproved` branches on
      // `request.type` before it reads the dto, so the number is not validated
      // and rejected — it is ignored, which is a different claim and the one
      // that matters: an approver cannot spread an advance by accident.
      const id = await advance(200, 'one cycle', 6);

      const loan = await loanOf(adminApi, id);
      expect(loan.status).toBe('APPROVED');
      expect(loan.installments, 'an advance was spread over more than one cycle').toBe(1);
      expect(numOf(loan, 'installmentAmount'), 'the whole advance is not taken in one go').toBe(200);

      // One schedule row is what "recovers in one payroll cycle" MEANS to the
      // recovery planner — it reads the plan, not the `installments` column.
      const plan = await scheduleOf(adminApi, id);
      expect(plan.length, 'the advance was amortized').toBe(1);
      expect(plan[0].emiAmount).toBe(200);
      expect(plan[0].principalComponent).toBe(200);
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(200);
    });

    test('an advance larger than a month of pay is not refused, because the requester has no pay on record', async () => {
      const check = await employeeApi.post<EligibilityResult>('/advance-loans/eligibility', {
        amount: 100_000,
        type: 'ADVANCE',
      });

      // The rule is real and is `NET_PAY_AFTER_EMI`: an ADVANCE has one
      // instalment, so its EMI is the whole amount, and the whole amount above
      // `loan_max_emi_percent_of_net` (50%) of monthly pay fails. Its guard is
      // `monthlyNet > 0`.
      const affordability = check.checks.find((c) => c.code === 'NET_PAY_AFTER_EMI');
      expect(affordability, 'the affordability rule is no longer evaluated at all').toBeTruthy();

      if (check.monthlyNet > 0) {
        expect(affordability!.status).toBe('FAIL');
        const problem = await refusal(
          employeeApi.post('/advance-loans', {
            type: 'ADVANCE',
            amount: 100_000,
            reason: `${mark} — above a month of pay`,
          }),
        );
        expect(problem).toContain('failed: 400');
        expect(problem).toMatch(/above 50% of monthly pay/i);
        return;
      }

      // BUG?: every login-capable seeded account carries baseSalary 0 and no salary components, so monthlyNet is 0 and an advance of ANY size clears every affordability rule.
      expect(check.monthlyNet).toBe(0);
      expect(affordability!.status, 'the affordability rule found a denominator after all').toBe('PASS');
      const id = await advance(100_000, 'above a month of pay');
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('APPROVED');
    });

    test('the active-loan cap counts advances, and the one past it is refused by name', async () => {
      // The cap is `loan_max_active_per_employee`, default 2, counted over every
      // NON-TERMINAL request — so two live advances exhaust it exactly as two
      // live loans would. Read rather than assumed: a site that raised it would
      // otherwise fail this case for a configuration change.
      const before = await employeeApi.post<EligibilityResult>('/advance-loans/eligibility', {
        amount: 100,
        type: 'ADVANCE',
      });
      const cap = before.checks.find((c) => c.code === 'MAX_ACTIVE_LOANS');
      expect(cap, 'the active-loan cap is no longer evaluated').toBeTruthy();
      test.skip(cap!.status === 'FAIL', 'this account is already at its cap — another spec holds a loan');

      // Room for BOTH, not just for one. The eligibility probe above only
      // proves the account is under its cap right now, and this case needs two
      // free slots — on a database this suite has run against before, the cases
      // above have left one of them filled. `ensureAllowance` cannot be used
      // twice here: its second call would retire `first`, which is the loan the
      // cap is supposed to be counting.
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      const first = await advance(100, 'cap 1 of 2');
      const second = await advance(100, 'cap 2 of 2');
      expect(first).not.toBe(second);

      const now = await employeeApi.post<EligibilityResult>('/advance-loans/eligibility', {
        amount: 100,
        type: 'ADVANCE',
      });
      const capNow = now.checks.find((c) => c.code === 'MAX_ACTIVE_LOANS')!;
      test.skip(
        capNow.status !== 'FAIL',
        `loan_max_active_per_employee is above 2 here, so two advances do not exhaust it`,
      );

      // The refusal names the count rather than saying "not eligible": a
      // requester has to be able to tell "you already have two" from "your
      // salary is too low", and both come back through the same 400.
      const problem = await refusal(
        employeeApi.post('/advance-loans', {
          type: 'ADVANCE',
          amount: 100,
          reason: `${mark} — cap 3 of 2`,
        }),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toMatch(/active advance\/loan record/i);
    });

    test('an advance waived in full closes as a waiver with nothing left owed', async () => {
      const id = await advance(300, 'waived to zero');

      await adminApi.post(`/advance-loans/${id}/waive`, {
        waiveType: 'BOTH',
        reason: `${mark} written down under the hardship policy`,
      });

      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('CLOSED');
      expect(after.closureType).toBe('WAIVER');
      // The whole balance, not the instalment: a blank amount means "all of it"
      // and the server caps the waiver at the outstanding rather than trusting
      // a number it was not given.
      expect(numOf(after, 'waivedAmount')).toBe(300);
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(0);
    });

    test('advance_max_percent_of_salary does not cap an approval when the requester has no salary', async () => {
      test.skip(
        !flagFlipAllowed(),
        'changes advance_max_percent_of_salary, which is environment-wide — set E2E_ALLOW_FLAG_FLIP=1',
      );

      const check = await employeeApi.post<EligibilityResult>('/advance-loans/eligibility', {
        amount: 100,
        type: 'ADVANCE',
      });

      await withSetting(adminApi, 'advance_max_percent_of_salary', '1', async () => {
        const created = await employeeApi.post<{ id: string }>('/advance-loans', {
          type: 'ADVANCE',
          amount: 100,
          reason: `${mark} — percent cap`,
        });
        scratch.push(created.id);

        const approve = adminApi.post(`/advance-loans/${created.id}/approve`, {
          remarks: `${mark} approved under a 1% cap`,
        });

        if (check.monthlyNet > 0) {
          // The reachable half: the cap is applied at APPROVAL, not at filing,
          // and it names both figures so the approver knows what to do instead.
          const problem = await refusal(approve);
          expect(problem).toContain('failed: 400');
          expect(problem).toMatch(/exceeds 1% of the employee's monthly pay/i);
          expect(problem).toMatch(/raise a loan instead/i);
          return;
        }

        // BUG?: `applyApproved` guards the advance cap on `proxy > 0`, so for an employee with no recorded pay `advance_max_percent_of_salary` is inert at any value — a 1% cap approves 100% of nothing.
        await approve;
        expect(strOf(await loanOf(adminApi, created.id), 'status')).toBe('APPROVED');
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Conversion — past the single case the lifecycle journey already covers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `finance-loan-lifecycle.spec.ts` drives conversion once, through the screen,
 * and stops at "the advance closed and a PENDING loan exists". Everything that
 * makes conversion CORRECT rather than merely visible is below: the ledger pair
 * that keeps the receivable continuous, the closure arithmetic on the advance,
 * the provenance on the spawned loan, and the fact that the new terms do not
 * take effect until somebody decides on them.
 */
test.describe('converting an advance, past the point the screen journey stops', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  const advance = async (amount: number, note: string): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, {
      type: 'ADVANCE',
      amount,
      note: `${mark} — ${note}`,
      markerPrefix: MARKER_PREFIX,
    });
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
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'conversion is an ADMIN/HR surface');
    });

    test('conversion closes the advance at its full value and books the pair on both sides', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const advanceId = await advance(200, 'converted');
      const created = await adminApi.post<{ data?: { newLoanId?: string } }>(
        `/advance-loans/${advanceId}/convert`,
        { installments: 4, reason: `${mark} spread over four cycles` },
      );
      const spawnedId = String(
        (created as { data?: { newLoanId?: string }; newLoanId?: string }).data?.newLoanId ??
          (created as { newLoanId?: string }).newLoanId ??
          '',
      );
      expect(spawnedId, 'conversion returned no new loan id').toBeTruthy();
      scratch.push(spawnedId);

      const closed = await loanOf(adminApi, advanceId);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closureType).toBe('CONVERTED');
      // NOT a waiver and NOT a write-off: the money did not stop being owed, it
      // moved onto a different agreement. `amountRepaid = amount` is how the
      // advance stops carrying a balance without anyone being forgiven anything.
      expect(numOf(closed, 'amountRepaid'), 'the converted advance still shows a balance').toBe(200);
      expect((await quoteOf(adminApi, advanceId)).payoffAmount).toBe(0);

      // The pair is what keeps the receivable ledger continuous — a credit on
      // the advance and a debit on the loan, same amount, same instant. Without
      // both halves the book shows 200 vanishing and 200 appearing from nowhere.
      const statement = await adminApi.get<StatementLoan[]>(
        `/advance-loans/reports/employee/${strOf(closed, 'employeeId')}/statement`,
      );
      const conversionsOn = (id: string) =>
        (statement.find((l) => l.id === id)?.transactions ?? []).filter((t) => t.type === 'CONVERSION');

      const credit = conversionsOn(advanceId);
      const debit = conversionsOn(spawnedId);
      expect(credit.length, 'no CONVERSION transaction on the advance').toBe(1);
      expect(debit.length, 'no CONVERSION transaction on the spawned loan').toBe(1);
      expect(Number(credit[0].amount)).toBe(200);
      expect(Number(debit[0].amount), 'the two halves of the conversion disagree').toBe(200);
    });

    test('the spawned loan carries its provenance and re-enters approval', async () => {
      const advanceId = await advance(200, 'provenance');
      const created = await adminApi.post<{ data?: { newLoanId?: string }; newLoanId?: string }>(
        `/advance-loans/${advanceId}/convert`,
        { installments: 4, reason: `${mark} provenance` },
      );
      const spawnedId = String(created.data?.newLoanId ?? created.newLoanId ?? '');
      expect(spawnedId).toBeTruthy();
      scratch.push(spawnedId);

      const spawned = await loanOf(adminApi, spawnedId);
      expect(spawned.type).toBe('LOAN');
      // PENDING, not APPROVED: new terms need a fresh decision. An administrator
      // typing "4" into a conversion dialog must not be able to change what an
      // employee owes each month without an approval behind it.
      expect(spawned.status, 'the converted loan took effect without a decision').toBe('PENDING');
      expect(spawned.installments).toBe(4);
      expect(numOf(spawned, 'amount')).toBe(200);
      // The two columns that let a reader walk backwards from the new loan to
      // the advance it came from — the reason a conversion is auditable at all.
      expect(spawned.approvalSource).toBe('CONVERSION');
      expect(spawned.convertedFromId).toBe(advanceId);
    });

    test('the spawned loan recovers nothing until it is approved', async () => {
      const advanceId = await advance(200, 'awaiting approval');
      const created = await adminApi.post<{ data?: { newLoanId?: string }; newLoanId?: string }>(
        `/advance-loans/${advanceId}/convert`,
        { installments: 4, reason: `${mark} awaiting approval` },
      );
      const spawnedId = String(created.data?.newLoanId ?? created.newLoanId ?? '');
      expect(spawnedId).toBeTruthy();
      scratch.push(spawnedId);

      // No plan means nothing for the recovery planner to find: it reads
      // `LoanSchedule`, so an unapproved conversion is invisible to payroll
      // rather than merely flagged as unapproved.
      expect(await scheduleOf(adminApi, spawnedId), 'a PENDING loan already has a plan').toEqual([]);

      // And the lifecycle refuses to operate on it at all, in its own words.
      const problem = await refusal(
        adminApi.post(`/advance-loans/${spawnedId}/hold`, { reason: `${mark} too early` }),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('This request has not been approved yet');

      await adminApi.post(`/advance-loans/${spawnedId}/approve`, {
        remarks: `${mark} converted terms accepted`,
        installments: 4,
      });
      const plan = await scheduleOf(adminApi, spawnedId);
      expect(plan.length, 'approving the converted loan wrote no schedule').toBe(4);
      expect(strOf(await loanOf(adminApi, spawnedId), 'status')).toBe('APPROVED');
    });

    test('a LOAN cannot be converted, and the refusal says so in the server\'s words', async () => {
      const loanId = await liveLoan(employeeApi, adminApi, {
        type: 'LOAN',
        amount: 400,
        installments: 4,
        note: `${mark} — not an advance`,
        markerPrefix: MARKER_PREFIX,
      });
      scratch.push(loanId);

      const problem = await refusal(
        adminApi.post(`/advance-loans/${loanId}/convert`, {
          installments: 6,
          reason: `${mark} converting a loan`,
        }),
      );
      expect(problem).toContain('failed: 400');
      // The exact string from `loan-lifecycle.service.ts`. Quoted rather than
      // matched loosely because this is the sentence a user sees: the docs call
      // it "converted INTO a loan", the code says "converted TO a loan", and a
      // fuzzy assertion would let the two drift apart unnoticed.
      expect(problem).toContain('Only an advance can be converted to a loan');
      expect(strOf(await loanOf(adminApi, loanId), 'status'), 'the refused conversion closed the loan')
        .toBe('APPROVED');
    });

    test('a HELD advance is converted anyway, which is not what the panel implies', async () => {
      const advanceId = await advance(200, 'held then converted');
      await adminApi.post(`/advance-loans/${advanceId}/hold`, {
        reason: `${mark} recovery paused before the conversion`,
      });
      expect(strOf(await loanOf(adminApi, advanceId), 'status')).toBe('ON_HOLD');

      // BUG?: `convertToLoan` gates on `assertActive`, which admits ON_HOLD — so an advance whose recovery is explicitly PAUSED can still be converted over HTTP, while the screen hides every operation but Resume for exactly that status.
      const created = await adminApi.post<{ data?: { newLoanId?: string }; newLoanId?: string }>(
        `/advance-loans/${advanceId}/convert`,
        { installments: 4, reason: `${mark} converting a held advance` },
      );
      const spawnedId = String(created.data?.newLoanId ?? created.newLoanId ?? '');
      expect(spawnedId, 'converting a held advance produced no loan').toBeTruthy();
      scratch.push(spawnedId);

      const closed = await loanOf(adminApi, advanceId);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closureType).toBe('CONVERTED');
    });

    test('an instalment count outside 1..600 is refused before the service is reached', async () => {
      const advanceId = await advance(200, 'instalment range');

      // `ConvertAdvanceDto` is `@IsInt() @Min(1) @Max(600)`, so both ends are a
      // ValidationPipe 400 — the loan is never loaded and nothing can half-apply.
      for (const installments of [0, 601]) {
        const problem = await refusal(
          adminApi.post(`/advance-loans/${advanceId}/convert`, {
            installments,
            reason: `${mark} an impossible instalment count`,
          }),
        );
        expect(problem, `installments=${installments} was accepted`).toContain('failed: 400');
        expect(problem).toMatch(/installments/i);
      }

      // 600 itself is legal, and the advance is still exactly as it was — the
      // two refusals moved nothing.
      expect(strOf(await loanOf(adminApi, advanceId), 'status')).toBe('APPROVED');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — Settlement: the quote
// ═══════════════════════════════════════════════════════════════════════════

test.describe('the exit quote lists everything an employee still owes', () => {
  let adminApi: ApiClient;
  let hoId = '';
  let owing: TestEmployee | null = null;
  let clean: TestEmployee | null = null;
  let loanA = '';
  let loanB = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);

      owing = await makeEmployee(adminApi, { marker: `${mark}q1`, branchId: hoId });
      clean = await makeEmployee(adminApi, { marker: `${mark}q2`, branchId: hoId });

      loanA = await importLoan(adminApi, { code: owing.code, amount: 600, note: 'quote: loan' });
      loanB = await importLoan(adminApi, {
        code: owing.code,
        amount: 200,
        type: 'ADVANCE',
        note: 'quote: advance',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'settlement is an ADMIN/HR surface with no screen at all');
    });

    test('every non-terminal loan appears with its own balance and the total', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const quote = await quoteFor(adminApi, owing!.id);
      expect(quote.employeeId).toBe(owing!.id);
      expect(quote.loans.map((l) => l.loanId).sort()).toEqual([loanA, loanB].sort());

      const byId = new Map(quote.loans.map((l) => [l.loanId, l]));
      expect(byId.get(loanA)!.principal).toBe(600);
      expect(byId.get(loanA)!.total).toBe(600);
      expect(byId.get(loanB)!.type).toBe('ADVANCE');
      expect(byId.get(loanB)!.total).toBe(200);

      // The total is what an F&F calculation is built on, so it has to be the
      // sum rather than a figure computed some other way.
      expect(quote.totalOutstanding).toBe(800);
      expect(quote.cleared, 'an employee owing 800 was reported clear').toBe(false);
    });

    test('an employee who owes nothing gets an empty quote, not an error', async () => {
      // The difference between "no rows" and "404" is the whole usability of an
      // exit checklist: the overwhelmingly common case is somebody who never
      // borrowed, and that must render as a cleared line rather than as a
      // failure an operator has to interpret.
      const quote = await quoteFor(adminApi, clean!.id);
      expect(quote.loans).toEqual([]);
      expect(quote.totalOutstanding).toBe(0);
      expect(quote.cleared, 'an employee with no loans was not reported clear').toBe(true);
    });

    test('an employee id nobody has is a 404 rather than a confident empty quote', async () => {
      // The failure direction matters. `assertSettleableEmployee` resolves the
      // person FIRST; without it an unknown id matches no loans and answers
      // "cleared: true" — a clean bill of health for somebody who does not
      // exist, which is the same shape as findings R26/R27 on clearance.
      const problem = await refusal(
        quoteFor(adminApi, '00000000-0000-4000-8000-000000000000'),
      );
      expect(problem).toContain('failed: 404');
      expect(problem).toContain('Employee not found');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — Settlement: one test per decision
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Seven actions, seven outcomes, one loan each.
 *
 * They are separate tests rather than one settlement naming seven loans because
 * the ledger effects differ per action and a combined case would report "the
 * settlement succeeded" while any one of them silently did nothing.
 */
test.describe('every exit decision does what its name says', () => {
  let adminApi: ApiClient;
  let hrApi: ApiClient;
  let hoId = '';
  let subject: TestEmployee | null = null;
  let setupError = '';
  let scratch: string[] = [];

  const loanFor = async (amount: number, note: string): Promise<string> => {
    const id = await importLoan(adminApi, { code: subject!.code, amount, note });
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hrApi = await ApiClient.as('hr');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      // HR is NOT global-branch: `seed.ts` grants an HR_MANAGER access to the
      // default branch through `UserBranchAccess` and nothing wider. Scoping the
      // client to the branch its subjects live in is what keeps a role-gate case
      // failing on the ROLE rather than on a branch envelope — `assertInBranch`
      // answers 404, which would look nothing like the 403 under test.
      hrApi.withBranch(hoId);
      subject = await makeEmployee(adminApi, { marker: `${mark}d`, branchId: hoId });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  // Every decision leaves the loan somewhere, and a leftover in a NON-terminal
  // state (FINAL_PAY leaves it ACTIVE, CARRY leaves it RECEIVABLE) would be
  // named in the next test's quote and change what that test is measuring.
  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
    await hrApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'settlement is an ADMIN/HR surface with no screen at all');
    });

    test('RECOVER_FROM_FINAL_PAY flags the loan for the payroll planner and leaves it live', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await loanFor(600, 'final pay');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'RECOVER_FROM_FINAL_PAY', reason: `${mark} take it from the final pay` },
      ]);
      expect(result.settlementId).toBeTruthy();

      const after = await loanOf(adminApi, id);
      // ACTIVE on purpose, and this is the one decision that moves no money:
      // the planner lifts the minimum-take-home floor on a FINAL_SETTLEMENT run
      // and takes the whole balance, which it can only do against a loan it is
      // still allowed to recover from.
      expect(after.status, 'the loan was closed before payroll could collect it').toBe('ACTIVE');
      expect(after.settlementMode).toBe('FINAL_PAY');
      expect(numOf(after, 'amountRepaid'), 'a flag-only decision moved money').toBe(0);
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(600);
      expect(result.recovered).toBe(0);
    });

    test('RECOVER_FROM_GRATUITY books the recovery against the gratuity and settles the loan', async () => {
      const id = await loanFor(600, 'gratuity');
      const result = await settleFor(adminApi, subject!.id, [
        {
          loanId: id,
          action: 'RECOVER_FROM_GRATUITY',
          reference: `${mark}-grat`,
          reason: `${mark} recovered from gratuity`,
        },
      ]);

      // The payout itself is external — this repo has no gratuity model — so
      // what is asserted is the RECEIVABLE being satisfied, which is the half
      // this service owns.
      expect(result.recovered).toBe(600);
      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('SETTLED');
      expect(after.closureType).toBe('SETTLEMENT');
      expect(after.settlementMode).toBe('GRATUITY');
      expect(numOf(after, 'amountRepaid')).toBe(600);

      const statement = await adminApi.get<StatementLoan[]>(
        `/advance-loans/reports/employee/${subject!.id}/statement`,
      );
      const txns = (statement.find((l) => l.id === id)?.transactions ?? []).filter(
        (t) => t.type === 'SETTLEMENT',
      );
      expect(txns.length, 'the recovery left no ledger row').toBe(1);
      expect(Number(txns[0].amount)).toBe(600);
    });

    test('RECOVER_FROM_LEAVE_ENCASHMENT records the same recovery against a different source', async () => {
      const id = await loanFor(400, 'leave encashment');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'RECOVER_FROM_LEAVE_ENCASHMENT', reason: `${mark} from encashment` },
      ]);

      expect(result.recovered).toBe(400);
      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('SETTLED');
      // The SOURCE is the whole reason these are three actions rather than one:
      // a balance recovered from leave encashment and one recovered from
      // gratuity land in different places in the exit paperwork.
      expect(after.settlementMode).toBe('LEAVE_ENCASHMENT');
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(0);
    });

    test('PARTIAL takes what was offered and leaves the loan open for the rest', async () => {
      const id = await loanFor(600, 'partial');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'PARTIAL', amount: 250, reason: `${mark} all the final pay covered` },
      ]);

      expect(result.recovered).toBe(250);
      const after = await loanOf(adminApi, id);
      // Not SETTLED: `roundMoney(total - amount) <= 0.005` is the only route to
      // that status, and 350 is not inside a rounding tolerance. A part payment
      // that closed the loan would forgive 350 by accident.
      expect(after.status, 'a part payment closed the loan').not.toBe('SETTLED');
      expect(numOf(after, 'amountRepaid')).toBe(250);
      expect(after.settlementMode).toBe('FINAL_PAY');
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(350);

      // Interest-first allocation, asserted on an interest-free loan: the split
      // is `min(amount, loan.interest)` to interest and the remainder to
      // principal, so with no interest the whole payment must land on principal.
      // `loan_interest_enabled` is pinned false in the e2e baseline, which is
      // why this is the honest form of the claim here.
      const statement = await adminApi.get<StatementLoan[]>(
        `/advance-loans/reports/employee/${subject!.id}/statement`,
      );
      const txn = (statement.find((l) => l.id === id)?.transactions ?? []).find(
        (t) => t.type === 'SETTLEMENT',
      );
      expect(txn, 'the partial recovery left no ledger row').toBeTruthy();
      expect(Number(txn!.amount)).toBe(250);
    });

    test('PARTIAL that clears the balance settles the loan', async () => {
      const id = await loanFor(300, 'partial that clears');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'PARTIAL', amount: 300, reason: `${mark} the final pay covered it` },
      ]);

      expect(result.recovered).toBe(300);
      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('SETTLED');
      expect(after.closureType).toBe('SETTLEMENT');
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(0);
    });

    test('PARTIAL above the balance is refused with both figures named', async () => {
      const id = await loanFor(300, 'partial overshoot');
      const problem = await refusal(
        settleFor(adminApi, subject!.id, [
          { loanId: id, action: 'PARTIAL', amount: 500, reason: `${mark} more than is owed` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('Recovery of 500 exceeds the 300 outstanding');
      expect(strOf(await loanOf(adminApi, id), 'status'), 'a refused recovery still moved money')
        .toBe('ACTIVE');
    });

    test('WAIVE hands the work to the lifecycle waiver and closes the loan as one', async () => {
      const id = await loanFor(400, 'waived at exit');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'WAIVE', reason: `${mark} forgiven at exit` },
      ]);

      expect(result.waived).toBe(400);
      const after = await loanOf(adminApi, id);
      // CLOSED / WAIVER rather than SETTLED: the delegation is the point. One
      // waiver implementation means a settlement waiver and a screen waiver
      // produce the same record, the same ledger row and the same audit trail.
      expect(after.status).toBe('CLOSED');
      expect(after.closureType).toBe('WAIVER');
      expect(numOf(after, 'waivedAmount')).toBe(400);
      expect(numOf(after, 'amountRepaid'), 'a waiver was recorded as a repayment').toBe(0);
    });

    test('WRITE_OFF is still gated on advance_loan_writeoff_roles, settlement or not', async () => {
      const id = await loanFor(400, 'written off at exit');

      // The gate is a SETTING (`advance_loan_writeoff_roles`, pinned to ADMIN),
      // not the route decorator — which admits HR_MANAGER on both the lifecycle
      // route and this one. Settlement delegates to `lifecycle.writeOff`, so if
      // the delegation ever became a direct update the gate would evaporate and
      // an HR_MANAGER could forgive company money through the exit checklist.
      const problem = await refusal(
        settleFor(hrApi, subject!.id, [
          { loanId: id, action: 'WRITE_OFF', reason: `${mark} HR attempting a write-off` },
        ]),
      );
      expect(problem).toContain('failed: 403');
      expect(problem).toMatch(/not permitted to perform this operation/i);
      expect(strOf(await loanOf(adminApi, id), 'status'), 'the refused write-off went through anyway')
        .toBe('ACTIVE');

      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'WRITE_OFF', reason: `${mark} uncollectable after the exit` },
      ]);
      expect(result.writtenOff).toBe(400);
      const after = await loanOf(adminApi, id);
      expect(after.status).toBe('WRITTEN_OFF');
      expect(after.closureType).toBe('WRITE_OFF');
      expect(numOf(after, 'writtenOffAmount')).toBe(400);
    });

    test('CARRY_AS_RECEIVABLE keeps the debt on the books outside payroll', async () => {
      const id = await loanFor(500, 'carried');
      const result = await settleFor(adminApi, subject!.id, [
        {
          loanId: id,
          action: 'CARRY_AS_RECEIVABLE',
          reason: `${mark} settlement did not cover it`,
        },
      ]);

      expect(result.carried).toBe(500);
      const after = await loanOf(adminApi, id);
      // The "negative settlement" outcome: nothing was forgiven and nothing was
      // collected, so the balance survives — which is why RECEIVABLE is NOT a
      // terminal status and still shows up on the next quote.
      expect(after.status).toBe('RECEIVABLE');
      expect(after.settlementMode).toBe('CARRIED');
      expect((await quoteOf(adminApi, id)).payoffAmount).toBe(500);
      expect(String(after.closureRemarks ?? '')).toContain(mark);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — Settlement: what it refuses
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A settlement that can be filed incompletely is not a control.
 *
 * The guard that carries the module is the first one: naming every outstanding
 * loan. A silent omission at exit is precisely how a receivable disappears —
 * the employee is gone, nothing else in the system reconstructs the balance, and
 * the loan sits ACTIVE against somebody who will never be paid again.
 */
test.describe('settle refuses anything it could not record honestly', () => {
  let adminApi: ApiClient;
  let hoId = '';
  let mine: TestEmployee | null = null;
  let other: TestEmployee | null = null;
  let otherLoan = '';
  let setupError = '';
  let scratch: string[] = [];

  const loanFor = async (amount: number, note: string): Promise<string> => {
    const id = await importLoan(adminApi, { code: mine!.code, amount, note });
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      mine = await makeEmployee(adminApi, { marker: `${mark}g1`, branchId: hoId });
      other = await makeEmployee(adminApi, { marker: `${mark}g2`, branchId: hoId });
      otherLoan = await importLoan(adminApi, {
        code: other.code,
        amount: 300,
        note: 'guards: somebody else',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'settlement is an ADMIN/HR surface with no screen at all');
    });

    test('a loan left out of the decision list is named in the refusal', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const named = await loanFor(600, 'guards: named');
      const forgotten = await loanFor(200, 'guards: forgotten');

      const problem = await refusal(
        settleFor(adminApi, mine!.id, [
          { loanId: named, action: 'WAIVE', reason: `${mark} decided` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('Every outstanding loan must have a settlement decision');
      // Named individually rather than counted: "1 loan is missing" leaves an
      // operator hunting, and the reference number is what they have in front
      // of them.
      const forgottenRef = strOf(await loanOf(adminApi, forgotten), 'referenceNo');
      expect(problem).toContain(forgottenRef || forgotten);

      // Refused means refused — the loan that WAS named must not have been
      // waived on the way to discovering the one that was not.
      expect(strOf(await loanOf(adminApi, named), 'status')).toBe('ACTIVE');
    });

    test('an empty decision list is refused rather than read as "nothing to do"', async () => {
      const id = await loanFor(300, 'guards: empty list');

      // `decisions: []` passes @IsArray and @ArrayMaxSize, so this is the
      // SERVICE refusing, not the pipe: an empty list against an employee who
      // owes money is the same omission as a short one.
      const problem = await refusal(settleFor(adminApi, mine!.id, []));
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('Every outstanding loan must have a settlement decision');
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('a loan id nobody has is refused before anything is applied', async () => {
      const id = await loanFor(300, 'guards: unknown id');

      // The unknown id goes FIRST on purpose. The decision loop is not wrapped
      // in a transaction, so ordering decides whether anything half-applied —
      // and this case is about the refusal itself, with the partial-application
      // question asked separately below.
      const problem = await refusal(
        settleFor(adminApi, mine!.id, [
          {
            loanId: '00000000-0000-4000-8000-000000000001',
            action: 'WAIVE',
            reason: `${mark} a loan that does not exist`,
          },
          { loanId: id, action: 'WAIVE', reason: `${mark} decided` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('is not outstanding for this employee');
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('a loan belonging to somebody else is refused, and nothing before it is applied', async () => {
      const id = await loanFor(300, 'guards: foreign loan');

      // Somebody else's loan LAST, so the honest decision has already been
      // applied when the refusal lands. That is the shape of a real mistake —
      // a copy-pasted id at the bottom of a long exit checklist.
      const problem = await refusal(
        settleFor(adminApi, mine!.id, [
          { loanId: id, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried` },
          { loanId: otherLoan, action: 'WAIVE', reason: `${mark} not this employee's loan` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain(otherLoan);
      expect(problem).toContain('is not outstanding for this employee');

      // Somebody else's loan is untouched, which is the half that must never
      // fail.
      expect(strOf(await loanOf(adminApi, otherLoan), 'status')).toBe('ACTIVE');

      // And the honest decision that came FIRST is not applied either.
      // `planSettlement` validates the whole decision set before a single
      // write, so a copy-pasted id at the bottom of an exit checklist refuses
      // the settlement rather than half-performing it. This used to leave the
      // loan stranded in RECEIVABLE with no LoanSettlement row to reverse it
      // from — money moved, no undo — on the one operation that runs while
      // somebody is walking out the door.
      expect(
        strOf(await loanOf(adminApi, id), 'status'),
        'a refused settlement still applied the decision that preceded the bad one',
      ).toBe('ACTIVE');
    });

    test('more than a hundred decisions is refused by the pipe, before any loan is read', async () => {
      const id = await loanFor(300, 'guards: too many');

      // `@ArrayMaxSize(100)`. The same id repeated is enough — the pipe counts
      // the array before the service resolves anything, which is the claim: the
      // ceiling is not enforced by running out of loans.
      const problem = await refusal(
        settleFor(
          adminApi,
          mine!.id,
          Array.from({ length: 101 }, () => ({
            loanId: id,
            action: 'WAIVE' as const,
            reason: `${mark} one of a hundred and one`,
          })),
        ),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toMatch(/decisions/i);
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('an action the enum does not have is refused rather than falling through', async () => {
      const id = await loanFor(300, 'guards: bad action');

      // `@IsIn([...])` on the DTO catches it. The service has a `default:` arm
      // too — belt and braces on purpose, because the DTO types `action` as
      // `any` and a widened enum would otherwise reach the switch untyped.
      const problem = await refusal(
        settleFor(adminApi, mine!.id, [
          { loanId: id, action: 'FORGIVE_EVERYTHING', reason: `${mark} not a real action` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toMatch(/action/i);
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('an amount carrying a third decimal is refused, because money here has two', async () => {
      const id = await loanFor(300, 'guards: three decimals');

      // `@IsNumber({ maxDecimalPlaces: 2 })`. The column is `Decimal(12,2)`, so
      // a third decimal is silently rounded by the database — the refusal is
      // what stops 10.125 being recorded as 10.13 and the ledger disagreeing
      // with the request that produced it.
      const problem = await refusal(
        settleFor(adminApi, mine!.id, [
          { loanId: id, action: 'PARTIAL', amount: 10.125, reason: `${mark} three decimals` },
        ]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toMatch(/amount/i);
      expect(numOf(await loanOf(adminApi, id), 'amountRepaid')).toBe(0);
    });

    test('a reason of one or two characters is refused, because it explains nothing', async () => {
      const id = await loanFor(300, 'guards: thin reason');

      // `@Length(3, 500)` on the per-decision reason. Three characters is a low
      // bar, and clearing it is still the difference between an auditable
      // decision and a blank one.
      const problem = await refusal(
        settleFor(adminApi, mine!.id, [{ loanId: id, action: 'WAIVE', reason: 'no' }]),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toMatch(/reason/i);
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — Settlement: reversal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A settlement is a decision made in a hurry on somebody's last day, and it has
 * to be undoable.
 *
 * The mechanism is a snapshot: `settle` records every affected loan's pre-state
 * into `decisionsJson` BEFORE anything moves, and `reverseSettlement` writes it
 * back column by column. That is what makes the reversal exact rather than a
 * guess at what a waiver "probably" changed.
 */
test.describe('a settlement can be taken back, by an ADMIN and only once', () => {
  let adminApi: ApiClient;
  let hrApi: ApiClient;
  let hoId = '';
  let subject: TestEmployee | null = null;
  let setupError = '';
  let scratch: string[] = [];

  const loanFor = async (amount: number, note: string): Promise<string> => {
    const id = await importLoan(adminApi, { code: subject!.code, amount, note });
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hrApi = await ApiClient.as('hr');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      // HR is NOT global-branch: `seed.ts` grants an HR_MANAGER access to the
      // default branch through `UserBranchAccess` and nothing wider. Scoping the
      // client to the branch its subjects live in is what keeps a role-gate case
      // failing on the ROLE rather than on a branch envelope — `assertInBranch`
      // answers 404, which would look nothing like the 403 under test.
      hrApi.withBranch(hoId);
      subject = await makeEmployee(adminApi, { marker: `${mark}r`, branchId: hoId });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
    await hrApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'settlement is an ADMIN/HR surface with no screen at all');
    });

    test('reversing restores every loan to the state the snapshot recorded', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const waived = await loanFor(400, 'reversal: waived');
      const carried = await loanFor(500, 'reversal: carried');

      const result = await settleFor(adminApi, subject!.id, [
        { loanId: waived, action: 'WAIVE', reason: `${mark} forgiven` },
        { loanId: carried, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried` },
      ]);
      expect(strOf(await loanOf(adminApi, waived), 'status')).toBe('CLOSED');
      expect(strOf(await loanOf(adminApi, carried), 'status')).toBe('RECEIVABLE');

      const undone = await reverseSettlement(adminApi, result.settlementId, `${mark} decided too fast`);
      expect(String(undone.message ?? '')).toContain('2 loan(s) restored');

      // Both loans back to ACTIVE, and — the part a "just set the status back"
      // implementation would miss — the money columns back too. A waiver that
      // was reversed without clearing `waivedAmount` leaves a loan that is
      // ACTIVE and owes 0.
      const waivedAfter = await loanOf(adminApi, waived);
      expect(waivedAfter.status).toBe('ACTIVE');
      expect(numOf(waivedAfter, 'waivedAmount'), 'the waiver outlived its own reversal').toBe(0);
      expect(waivedAfter.closureType, 'the closure survived the reversal').toBeFalsy();
      expect((await quoteOf(adminApi, waived)).payoffAmount).toBe(400);

      const carriedAfter = await loanOf(adminApi, carried);
      expect(carriedAfter.status).toBe('ACTIVE');
      expect(carriedAfter.settlementMode, 'the carry flag outlived the reversal').toBeFalsy();

      // And the quote is whole again, which is the operator-visible claim: the
      // exit checklist is back to where it started.
      const quote = await quoteFor(adminApi, subject!.id);
      expect(quote.totalOutstanding).toBe(900);
    });

    test('an HR_MANAGER cannot reverse a settlement they were allowed to record', async () => {
      const id = await loanFor(300, 'reversal: role gate');

      // The asymmetry is the rule: `@Roles('ADMIN','HR_MANAGER')` on settle,
      // `@Roles('ADMIN')` on reverse. Recording an exit decision is HR's job;
      // un-recording one restores a debt against somebody who has already left,
      // and that is an administrator's.
      const result = await settleFor(hrApi, subject!.id, [
        { loanId: id, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} HR carried it` },
      ]);
      expect(result.settlementId, 'HR was refused the settlement itself').toBeTruthy();

      const problem = await refusal(
        reverseSettlement(hrApi, result.settlementId, `${mark} HR attempting a reversal`),
      );
      expect(problem).toContain('failed: 403');
      expect(strOf(await loanOf(adminApi, id), 'status'), 'the refused reversal ran anyway')
        .toBe('RECEIVABLE');

      // The same call from an ADMIN goes through, which is what proves the 403
      // was the ROLE and not a broken settlement id.
      await reverseSettlement(adminApi, result.settlementId, `${mark} admin undoing HR's decision`);
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('a settlement can only be reversed once', async () => {
      const id = await loanFor(300, 'reversal: twice');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried` },
      ]);

      await reverseSettlement(adminApi, result.settlementId, `${mark} first reversal`);

      // Idempotence is not enough here: replaying the snapshot a second time
      // would restore a loan that has moved on since, silently undoing whatever
      // was done to it in between.
      const problem = await refusal(
        reverseSettlement(adminApi, result.settlementId, `${mark} second reversal`),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('already been reversed');
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('ACTIVE');
    });

    test('reversing a settlement that never existed is a 404', async () => {
      const problem = await refusal(
        reverseSettlement(
          adminApi,
          '00000000-0000-4000-8000-000000000002',
          `${mark} no such settlement`,
        ),
      );
      expect(problem).toContain('failed: 404');
      expect(problem).toContain('Settlement not found');
    });

    test('a settlement id where an employee id belongs answers 404, not somebody else\'s quote', async () => {
      const id = await loanFor(300, 'route collision');
      const result = await settleFor(adminApi, subject!.id, [
        { loanId: id, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried` },
      ]);

      // `GET /advance-loans/settlement/:employeeId` matches ANY uuid, and a
      // settlement id is a uuid — so the route pattern alone cannot tell the two
      // apart. What separates them is that `assertSettleableEmployee` resolves
      // the EMPLOYEE first: a settlement id is not an employee id, so it is a
      // 404 rather than an empty-but-successful quote. That ordering is the
      // whole defence and it is worth a test of its own.
      const problem = await refusal(quoteFor(adminApi, result.settlementId));
      expect(problem).toContain('failed: 404');
      expect(problem).toContain('Employee not found');

      // The POST twin has the same shape and must answer the same way.
      const posted = await refusal(
        settleFor(adminApi, result.settlementId, [
          { loanId: id, action: 'WAIVE', reason: `${mark} through the wrong door` },
        ]),
      );
      expect(posted).toContain('failed: 404');
      expect(strOf(await loanOf(adminApi, id), 'status')).toBe('RECEIVABLE');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 — The receivable book, and the rehire
// ═══════════════════════════════════════════════════════════════════════════

test.describe('a carried balance survives the exit and the return', () => {
  let adminApi: ApiClient;
  let hoId = '';
  let leaver: TestEmployee | null = null;
  let settled: TestEmployee | null = null;
  let carriedLoan = '';
  let settledLoan = '';
  let makeEmployeeError = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      try {
        leaver = await makeEmployee(adminApi, { marker: `${mark}rh1`, branchId: hoId });
        settled = await makeEmployee(adminApi, { marker: `${mark}rh2`, branchId: hoId });
      } catch (e) {
        makeEmployeeError = (e as Error).message;
        return;
      }

      carriedLoan = await importLoan(adminApi, {
        code: leaver.code,
        amount: 750,
        note: 'rehire: carried',
      });
      settledLoan = await importLoan(adminApi, {
        code: settled.code,
        amount: 250,
        note: 'rehire: settled',
      });

      await settleFor(adminApi, leaver.id, [
        { loanId: carriedLoan, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried at exit` },
      ]);
      await settleFor(adminApi, settled.id, [
        { loanId: settledLoan, action: 'RECOVER_FROM_GRATUITY', reason: `${mark} recovered at exit` },
      ]);

      // Only the carried one leaves. `terminateEmployee` supplies the clearance
      // override — a RECEIVABLE loan does not block an exit (it is a decision
      // that has already been taken) but an ACTIVE one would, and the helper's
      // override keeps setup from failing for a rule this describe is not about.
      await terminateEmployee(adminApi, leaver.id);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'settlement is an ADMIN/HR surface with no screen at all');
      test.skip(
        !!makeEmployeeError,
        `makeEmployee is unavailable here, and this journey terminates its subject: ${makeEmployeeError}`,
      );
    });

    test('the receivable list is exactly the RECEIVABLE loans and nothing else', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const book = await receivableBook(adminApi);
      const ids = book.map((r) => r.id);
      expect(ids, 'a carried balance is missing from the receivable book').toContain(carriedLoan);
      // The settled one must be ABSENT. A list that returned every loan an exit
      // touched would report money as recoverable that has already been
      // recovered, which is the failure this list exists to prevent.
      expect(ids, 'a recovered loan is being chased as a receivable').not.toContain(settledLoan);
      expect(
        book.every((r) => r.status === 'RECEIVABLE'),
        'the receivable book carries loans in other statuses',
      ).toBe(true);
    });

    test('a rehired employee still owes what they were carrying', async () => {
      // The rehire is the reason RECEIVABLE is not terminal. Reactivating the
      // person deliberately does NOT auto-resume the debt — resurrecting a
      // liability is not a decision code should make — so what is asserted is
      // that the balance is still THERE to be resumed, not that it restarted.
      await adminApi.patch(`/employees/${leaver!.id}`, { status: 'ACTIVE' });

      const loan = await loanOf(adminApi, carriedLoan);
      expect(loan.status, 'the rehire silently closed the carried balance').toBe('RECEIVABLE');
      expect((await quoteOf(adminApi, carriedLoan)).payoffAmount).toBe(750);

      const book = await receivableBook(adminApi);
      expect(book.map((r) => r.id), 'the rehire dropped the balance off the receivable book')
        .toContain(carriedLoan);

      // And the exit checklist would find it again if they left a second time —
      // RECEIVABLE is non-terminal, so the next quote names it.
      const quote = await quoteFor(adminApi, leaver!.id);
      expect(quote.loans.map((l) => l.loanId)).toContain(carriedLoan);
      expect(quote.totalOutstanding).toBe(750);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two screens a settled loan actually reaches
// ═══════════════════════════════════════════════════════════════════════════

/**
 * There is no settlement screen, but there IS a loan detail route, and it has to
 * cope with the two statuses only settlement can produce.
 *
 * That is not decoration: `SETTLED` and `RECEIVABLE` are the two statuses most
 * likely to fall through a `switch` written before settlement existed, and the
 * symptom would be an Actions panel offering operations the server refuses — or
 * a headed, empty box, which reads as a bug.
 */
test.describe('the loan detail route explains a status only settlement can produce', () => {
  let adminApi: ApiClient;
  let hoId = '';
  let subject: TestEmployee | null = null;
  let settledLoan = '';
  let carriedLoan = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      subject = await makeEmployee(adminApi, { marker: `${mark}ui`, branchId: hoId });

      settledLoan = await importLoan(adminApi, {
        code: subject.code,
        amount: 300,
        note: 'screen: settled',
      });
      carriedLoan = await importLoan(adminApi, {
        code: subject.code,
        amount: 500,
        note: 'screen: carried',
      });

      await settleFor(adminApi, subject.id, [
        { loanId: settledLoan, action: 'RECOVER_FROM_GRATUITY', reason: `${mark} recovered` },
        { loanId: carriedLoan, action: 'CARRY_AS_RECEIVABLE', reason: `${mark} carried` },
      ]);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the loan detail operations panel is an ADMIN/HR surface');
    });

    test('a settled loan shows its status and says why nothing is left to do', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await selectBranch(page, hoId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(settledLoan);
      await detail.expectStatus('SETTLED');

      // The Actions panel is drawn only when it would have buttons; when it
      // would not, the page says so in the user's terms. Both halves matter —
      // an offered operation on a settled loan is a 400 waiting to happen.
      await expect
        .poll(async () => (await detail.noActionsReason())?.status, { timeout: 15_000 })
        .toBe('SETTLED');
      expect(await detail.operations(), 'a settled loan was offered money operations').toEqual([]);

      // The money tiles agree with the record: nothing outstanding, everything
      // repaid. Read from `data-value`, never from the rendered currency.
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(0);
      expect(await detail.summary('repaid')).toBe(300);

      settle(problems, 'a settled loan on the detail route');
    });

    test('a carried receivable is drawn as still owed, with no payroll operation offered', async ({
      page,
      problems,
    }) => {
      await selectBranch(page, hoId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(carriedLoan);
      await detail.expectStatus('RECEIVABLE');

      // The distinction this screen has to carry: SETTLED means the money is in,
      // RECEIVABLE means it is still owed and payroll is simply not the one
      // collecting it. A tile showing 0 outstanding here would be a lie.
      await expect.poll(() => detail.summary('outstanding'), { timeout: 15_000 }).toBe(500);
      await expect
        .poll(async () => (await detail.noActionsReason())?.status, { timeout: 15_000 })
        .toBe('RECEIVABLE');
      expect(await detail.operations(), 'a carried receivable was offered payroll operations')
        .toEqual([]);

      settle(problems, 'a carried receivable on the detail route');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Clearance — the one screen that tells an approver a LOAN is the blocker
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Offboarding is refused while an advance or loan balance stands, and the
 * termination queue has to say so BEFORE the approver clicks.
 *
 * The banner is where finding R20 lived: `ClearanceStatus` carried only
 * `openAssets`, so a loan-blocked employee was told "Blocked: 0 company assets
 * not returned" and sent to the Asset Register, which would show them nothing.
 * The assertions below are per-loan rows and the count attribute, because a
 * headline that merely says "blocked" would have passed R20 too.
 */
test.describe('a loan balance blocks an exit, and the queue names it', () => {
  let adminApi: ApiClient;
  let hoId = '';
  let subject: TestEmployee | null = null;
  let loanId = '';
  let requestId = '';
  /** The approving principal. `ApproveTerminationDto` requires it and it must be a UUID. */
  let approverId = '';
  let makeEmployeeError = '';
  let setupError = '';

  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** Hires somebody, lends them money, and files their termination. */
  async function stage(tag: string): Promise<{ employee: TestEmployee; loan: string; request: string }> {
    const employee = await makeEmployee(adminApi, { marker: `${mark}${tag}`, branchId: hoId });
    const loan = await importLoan(adminApi, {
      code: employee.code,
      amount: 900,
      note: `clearance: ${tag}`,
    });
    const contract = await adminApi.post<{ id: string }>('/contracts', {
      employeeId: employee.id,
      contractType: 'INDEFINITE',
      startDate: '2025-06-01',
      salary: 60000,
    });
    const me = await adminApi.get<{ id: string }>('/auth/me');
    const request = await adminApi.post<{ id: string }>('/contracts/termination-requests', {
      contractId: contract.id,
      requestedBy: me.id,
      terminationCategory: 'RESIGNATION',
      noticeDate: daysFromNow(0),
      terminationDate: daysFromNow(30),
      reason: `${mark} leaving with a balance outstanding`,
    });
    return { employee, loan, request: request.id };
  }

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoId);
      approverId = (await adminApi.get<{ id: string }>('/auth/me')).id;
      try {
        const staged = await stage('cl');
        subject = staged.employee;
        loanId = staged.loan;
        requestId = staged.request;
      } catch (e) {
        makeEmployeeError = (e as Error).message;
      }
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the termination queue is an ADMIN/HR surface');
      test.skip(
        !!makeEmployeeError,
        `makeEmployee is unavailable here, and this journey terminates its subject: ${makeEmployeeError}`,
      );
    });

    test('the queue names the outstanding loan, refuses the approval, and lets go once it is settled', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      await selectBranch(page, hoId);
      const queue = new TerminationsPage(page);
      await queue.open();
      await expect(queue.row(requestId)).toBeVisible({ timeout: 20_000 });

      const banner = new ClearanceBannerPanel(page, requestId);
      // Polled: the banner fetches its own clearance and renders `loading`
      // first, so a single read lands on a state that is neither answer.
      await expect.poll(() => banner.state(), { timeout: 15_000 }).toBe('blocked');
      expect(await banner.isCleared()).toBe(false);
      // The count attribute AND the per-loan row. R20 was a banner that was
      // correctly "blocked" and named the wrong obligation, so "it says blocked"
      // is not the assertion — "it says ONE LOAN, and here it is" is.
      expect(await banner.outstandingLoanCount(), 'the blocking loan was not counted').toBe(1);
      expect(await banner.openAssetCount(), 'a loan block was reported as an asset block').toBe(0);
      await expect(banner.outstandingLoan(loanId)).toBeVisible();

      // The screen is a warning; the server is the control. Asserted over HTTP
      // so the refusal does not reach the browser as a console error.
      const problem = await refusal(
        adminApi.post(`/contracts/termination-requests/${requestId}/approve`, {
          approverId,
          comments: `${mark} approving while a balance stands`,
        }),
      );
      expect(problem).toContain('failed: 400');
      expect(problem).toContain('Cannot complete offboarding');
      expect(problem).toMatch(/outstanding advance\/loan balance/i);

      // Settle the balance — the only way to clear a loan block short of an
      // audited override — and the block lifts.
      await settleFor(adminApi, subject!.id, [
        { loanId, action: 'WAIVE', reason: `${mark} forgiven so the exit can complete` },
      ]);

      await queue.open();
      const cleared = new ClearanceBannerPanel(page, requestId);
      await expect.poll(() => cleared.state(), { timeout: 15_000 }).toBe('cleared');
      expect(await cleared.isCleared()).toBe(true);

      await adminApi.post(`/contracts/termination-requests/${requestId}/approve`, {
        approverId,
        comments: `${mark} approving now that the balance is gone`,
      });
      const person = await adminApi.get<{ status: string }>(`/employees/${subject!.id}`);
      expect(person.status, 'the exit still did not complete once the balance was settled')
        .toBe('INACTIVE');

      settle(problems, 'the termination queue with a loan balance outstanding');
    });

    test('with loan_clearance_blocking_enabled off the exit completes, though the banner still says blocked', async ({
      page,
      problems,
    }) => {
      test.skip(
        !flagFlipAllowed(),
        'changes loan_clearance_blocking_enabled, which is environment-wide — set E2E_ALLOW_FLAG_FLIP=1',
      );

      const staged = await stage('cf');

      await withSetting(adminApi, 'loan_clearance_blocking_enabled', 'false', async () => {
        await selectBranch(page, hoId);
        const queue = new TerminationsPage(page);
        await queue.open();
        await expect(queue.row(staged.request)).toBeVisible({ timeout: 20_000 });

        // BUG?: the kill-switch is read only by `assertCleared`, never by `getClearanceStatus`, so with loan blocking OFF the banner still renders "blocked" and names a loan that will not in fact stop the approval.
        const banner = new ClearanceBannerPanel(page, staged.request);
        await expect.poll(() => banner.state(), { timeout: 15_000 }).toBe('blocked');
        expect(await banner.outstandingLoanCount()).toBe(1);

        // The switch is what the case is actually about: the same approval that
        // was refused above now goes through with the balance untouched.
        await adminApi.post(`/contracts/termination-requests/${staged.request}/approve`, {
          approverId,
          comments: `${mark} approving with loan blocking switched off`,
        });
        const person = await adminApi.get<{ status: string }>(`/employees/${staged.employee.id}`);
        expect(person.status).toBe('INACTIVE');

        // And the debt is still there — switching the block off changes who is
        // stopped, not what is owed.
        expect(strOf(await loanOf(adminApi, staged.loan), 'status')).toBe('ACTIVE');
        expect((await quoteOf(adminApi, staged.loan)).payoffAmount).toBe(900);
      });

      settle(problems, 'a termination approved with loan clearance switched off');
    });
  });
});
