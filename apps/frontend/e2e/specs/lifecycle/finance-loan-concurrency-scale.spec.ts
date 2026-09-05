import { randomUUID } from 'crypto';
import { test, expect, settle, ApiClient } from '../../fixtures';
import { AdvanceLoansPage } from '../../pages';
import { LoanToolbar, selectBranch } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  ensureBranch,
  deductionsFor,
  ensureAllowance,
  flagFlipAllowed,
  loanOf,
  makeEmployee,
  payrollItemFor,
  quoteOf,
  retire,
  retireAllMarked,
  runPayroll,
  scheduleOf,
  clearPayrolls,
  deletePayroll,
  // NOT `lockPayroll`: it wraps one client and rethrows, and the lock race needs
  // two raw POSTs from two independent sessions whose refusals are compared as
  // a set. The helper is right for every other caller and wrong for exactly this.
  terminateEmployee,
  withSettings,
  type TestEmployee,
} from '../../loan-support';

/**
 * What the loan engine does when two people — or two payroll runs — reach for
 * the same money at the same moment, and what it does when the book is large.
 *
 * ## Why this file is worth its runtime
 *
 * Every other loan spec asks "does this operation do the right thing?". This one
 * asks the only question that matters once the answer to that is yes: **can the
 * same money move twice?** Every guard in the module exists for that question
 * and every one of them is invisible to a sequential test:
 *
 *   • `casVersion` — a compare-and-set on `AdvanceLoanRequest.version`, used by
 *     prepay / waive / write-off / close / hold / resume / skip. It exists
 *     because the Prisma branch middleware deliberately skips `updateMany` on
 *     relation-scoped models, so a stale writer has to lose AT THE DATABASE.
 *     A single-threaded test never produces a stale writer.
 *   • `LoanTransaction.idempotencyKey` — unique, with a pre-check that turns the
 *     retry into a clean 409 instead of a 500 from the constraint. Both halves
 *     only ever run when two requests overlap.
 *   • `advance_loan_deductions_schedule_live_uq` — ONE live recovery row per
 *     planned instalment, enforced by a partial unique index rather than by an
 *     application read-then-write that two concurrent payroll runs interleave.
 *   • `pg_advisory_xact_lock` + a compare-and-set on payroll status in
 *     `applyLock` — two admins clicking Finalize at once must not both flip the
 *     ledger.
 *   • The RECONCILIATION step after `skipDuplicates: true` — when a concurrent
 *     run has already claimed an instalment, the payslip is RESTATED from what
 *     the ledger actually holds. Without it the employee's net is reduced by
 *     money that has no ledger row: withheld but never credited, which is the
 *     worst outcome available in this module.
 *
 * ## How a race is asserted here
 *
 * Never on WHO won. Two HTTP requests fired at one server have no defined
 * order, and a spec that asserts an order is asserting the scheduler. Every case
 * below drives `Promise.allSettled` over INDEPENDENT `ApiClient`s and then
 * asserts the SHAPE of the outcome set — exactly one fulfilled, exactly one
 * refused — followed by the assertion that is the actual point: **the balance
 * moved exactly once.** The status codes are corroboration; the money is the
 * claim. A lost update or a double charge is marked `// MONEY BUG?:`.
 *
 * A shape assertion here has one honest failure mode worth naming up front: if
 * the two requests do not actually overlap on the server — a cold worker, a
 * paused container — the second one reads the state the first one already
 * committed and legitimately succeeds. Every message below says so, so a reader
 * seeing "both calls succeeded" knows to check whether the guard disappeared or
 * whether the race simply did not happen.
 *
 * ## Where the subjects live, and why it differs per group
 *
 *   • The pure-lifecycle races use an employee in **HO** whose loans are
 *     imported with a first deduction period ~13 years out. Nothing any spec
 *     generates (payroll-depth and wps run 30–48 months forward) can claim an
 *     instalment that is not due, so `assertNoRunInFlight` can never fire on
 *     them and a race here can never fail for another file's reason.
 *   • The payroll races and the scale seeding run in a branch this file CREATES
 *     (`PW-LOANSCALE`, via `ensureBranch`), because a payroll run is per-branch,
 *     HO is contended, and the loans seeded here can never be deleted. Runs are
 *     scoped with `employeeIds` to this file's own subjects so a run here cannot
 *     claim another spec's instalment and strand it behind the in-flight guard.
 *   • The approval races use a SEEDED account, because only the requester can
 *     file a request: `POST /advance-loans` is `@Roles('HR_MANAGER','MANAGER',
 *     'EMPLOYEE')` and takes the employee from the token, and an API-created
 *     employee has no usable password (see `makeEmployee`'s `NO_LOGIN`). So a
 *     PENDING loan can only exist on an account this suite can log in as.
 *
 * ### One consequence a future reader should know about
 *
 * The scale group leaves a permanent loan book behind — loans cannot be
 * hard-deleted (`DELETE /advance-loans/:id` only CANCELS a PENDING request), so
 * "retired" here means WRITTEN_OFF, and a written-off row is still a row. That
 * book lives in this file's OWN branch, so nothing else ever sees it. It used to
 * be seeded into `E2E-BR2`, which broke `finance-loan-lifecycle.spec.ts`'s case
 * that picks the first non-HO branch and asserts its book is empty — hence the
 * dedicated branch. Do not point this file back at a shared one.
 *
 * ## Everything the loans are created by, and why it is the importer
 *
 * `POST /advance-loans/import/confirm` is the only route that can produce a
 * live, scheduled, ACTIVE loan for an arbitrary employee without a session and
 * without spending the `loan_max_active_per_employee` allowance (which is 2).
 * It runs no eligibility check at all — deliberately: imported loans "were
 * approved elsewhere". That is what makes seeding 500 of them across ten
 * employees possible without flipping a single setting, and it is why the scale
 * group is NOT gated on `flagFlipAllowed()` while the bulk-approval group,
 * which genuinely needs the cap raised, is.
 *
 * ## Scale: what is in scope, and what deliberately is not
 *
 * §20 of the catalogue asks for 10k and 100k loan books. **Those are out of
 * scope for Playwright and belong in a load harness**, and pretending otherwise
 * here would produce a test that takes an hour, fails on a laptop, and gets
 * deleted. What Playwright can honestly do is prove that the shape of the cost
 * curve has not changed — that an N+1 has not appeared between 100 and 500
 * loans — and that is what the two sizes below are for. The budgets are
 * deliberately loose; see BUDGETS for exactly how loose and why.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/**
 * The stable half of the marker — what identifies a record as THIS FILE'S across
 * runs. `retireAllMarked` and `ensureAllowance` both match on this literal, so
 * it is a constant and not derived from the per-run tag.
 */
const MARKER_PREFIX = 'pw-loanrace-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const MARK = `${MARKER_PREFIX}${Date.now().toString(36)}`;

/**
 * This file seeds hundreds of loans and can never delete them — see
 * `ensureBranch`. It therefore owns a branch of its own rather than sharing
 * `E2E-BR2`, whose loan book `finance-loan-lifecycle.spec.ts` asserts is empty.
 */
const SCALE_BRANCH_CODE = 'PW-LOANSCALE';

// ───────────────────────────────────────────────────────────────────────────
// Periods
// ───────────────────────────────────────────────────────────────────────────

/**
 * A payroll period `monthsForward` from now.
 *
 * Far-future on purpose and far-future by a DIFFERENT amount than every other
 * spec: `payroll-depth` picks 30–48 months out and `wps` sits beside it, so a
 * run generated here for the same branch and month would collide and the loser
 * would fail with "Payroll already exists" instead of with what it was testing.
 * Everything below is 90+ months out.
 */
function periodAt(monthsForward: number): { month: number; year: number } {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

const ym = (p: { month: number; year: number }): string =>
  `${p.year}-${String(p.month).padStart(2, '0')}`;

/**
 * A first-deduction period no payroll run in this suite will ever reach.
 *
 * The recovery planner selects `dueCycleKey <= cycleKey`, so an instalment that
 * is not yet due is invisible to every run — which is precisely how the
 * lifecycle races below stay immune to `assertNoRunInFlight` firing because
 * another spec generated a payroll for the branch they happen to share.
 */
const NEVER_DUE = periodAt(160);

// ───────────────────────────────────────────────────────────────────────────
// Reading money off the wire
// ───────────────────────────────────────────────────────────────────────────

/** Decimal columns cross the wire as strings. This is the one place that admits it. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** One `advance_loan_deductions` row, as the loan DETAIL route includes it. */
interface DeductionRow {
  id: string;
  requestId: string;
  scheduleId: string | null;
  payrollItemId: string | null;
  amount: string | number;
  principalComponent: string | number;
  status: string;
  month: number;
  year: number;
}

async function deductions(admin: ApiClient, loanId: string): Promise<DeductionRow[]> {
  return (await deductionsFor(admin, loanId)) as DeductionRow[];
}

const pending = (rows: DeductionRow[]): DeductionRow[] => rows.filter((r) => r.status === 'PENDING');

/** One `loan_transactions` row, as the employee statement returns it. */
interface TxnRow {
  type: string;
  amount: string | number;
  principalComponent: string | number;
  narration?: string | null;
  status: string;
}

/**
 * The money ledger for one loan.
 *
 * Comes off the employee STATEMENT rather than the loan detail route, because
 * the detail route includes `deductions` (the payroll ledger) but not
 * `transactions` (the money ledger) — and "exactly one EMI_RECOVERY row" is a
 * claim about the second of those.
 */
async function transactionsOf(
  admin: ApiClient,
  employeeId: string,
  loanId: string,
): Promise<TxnRow[]> {
  const raw = await admin.get<unknown>(`/advance-loans/reports/employee/${employeeId}/statement`);
  const box = raw as { data?: unknown } | null;
  const list = (Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box.data : []) as Array<{
    id: string;
    transactions?: TxnRow[];
  }>;
  return list.find((l) => l.id === loanId)?.transactions ?? [];
}

const countTxns = (rows: TxnRow[], type: string): number => rows.filter((t) => t.type === type).length;

// ───────────────────────────────────────────────────────────────────────────
// Racing
// ───────────────────────────────────────────────────────────────────────────

interface RaceReport {
  /** How many of the concurrent calls the server accepted. */
  fulfilled: number;
  /** The refusal messages, which carry the HTTP status (`ApiClient` puts it there). */
  refusals: string[];
  /** Per-call, in the order they were passed in. */
  won: boolean[];
}

function raceOf(results: PromiseSettledResult<unknown>[]): RaceReport {
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    refusals: results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))),
    won: results.map((r) => r.status === 'fulfilled'),
  };
}

/**
 * The shape assertion every race in this file makes: exactly one caller won, and
 * everybody else was refused for the RIGHT reason.
 *
 * The failure message names the alternative explanation on purpose. "Both calls
 * succeeded" has two causes — the guard is gone, or the two requests never
 * actually overlapped on the server — and a reader who cannot tell them apart
 * will either chase a phantom bug or dismiss a real one.
 */
function expectSingleWinner(
  results: PromiseSettledResult<unknown>[],
  label: string,
  pattern: RegExp,
): RaceReport {
  const race = raceOf(results);

  expect(
    race.fulfilled,
    `${label}: expected exactly ONE of ${results.length} concurrent calls to be accepted, saw ${race.fulfilled}.\n` +
      `If it is ${results.length}, either the concurrency guard is gone or the requests did not overlap ` +
      `on the server (a cold worker will serialise them). If it is 0, both were refused: ${race.refusals.join(' || ')}`,
  ).toBe(1);

  for (const refusal of race.refusals) {
    expect(
      refusal,
      `${label}: the losing call was refused, but not with the status this guard is supposed to answer`,
    ).toMatch(pattern);
  }
  return race;
}

// ───────────────────────────────────────────────────────────────────────────
// Seeding loans without a session
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row of the loan importer's confirm payload.
 *
 * `confirm` takes the PREVIEW's already-parsed rows, so it can be posted
 * directly as JSON — which matters here because `preview` is a multipart upload
 * and `ApiClient` speaks JSON only. Nothing is lost by skipping preview: it
 * persists nothing, and `confirm` re-runs the SAME `validateImportRow` over
 * every row, so a hand-built row is held to exactly the rules a previewed one
 * is. Every row built below satisfies them by construction — see `importRow`,
 * where each field that a rule touches says which rule.
 */
interface ImportRowData {
  employeeCode: string;
  referenceNo: string;
  type: 'ADVANCE' | 'LOAN';
  principal: number;
  interestMethod: 'NONE';
  interestRate: number;
  installments: number;
  emi: number | null;
  disbursedOn: string;
  firstDeductionPeriod: string;
  installmentsPaid: number;
  amountRepaid: number;
  status: 'ACTIVE';
  /** Lands in `AdvanceLoanRequest.reason`, which is the only field a sweep can match. */
  notes: string;
}

let refSeq = 0;

function importRow(opts: {
  employeeCode: string;
  principal?: number;
  installments?: number;
  firstDeductionPeriod: string;
  note: string;
}): ImportRowData {
  refSeq += 1;
  return {
    employeeCode: opts.employeeCode,
    referenceNo: `LN-${MARK}-${refSeq}`.toUpperCase().replace(/[^A-Z0-9/_-]/g, '-'),
    type: 'LOAN',
    // Whole rupees, so `hasExcessDecimals` cannot fire: the importer refuses a
    // money field with more than two decimal places.
    principal: opts.principal ?? 600,
    // NONE keeps every instalment's principal component equal to its EMI, which
    // is what lets a money assertion below be an exact integer rather than a
    // tolerance — the amortization engine is `loan-amortization.util.spec.ts`'s
    // subject, not this file's. It is also the only method the importer will
    // ACCEPT here: `loan_interest_enabled` is 'false' in the baseline seed and
    // an interest-bearing row is refused outright rather than coerced to NONE.
    interestMethod: 'NONE',
    interestRate: 0,
    // Above `loan_max_installments` is a WARNING, not an error — an importer
    // migrates history, and history is not subject to today's cap — so the
    // tenure here is free to be whatever a case needs.
    installments: opts.installments ?? 6,
    emi: null,
    // A real calendar date, comfortably after `makeEmployee`'s 2020-01-01 start
    // date and comfortably in the past: the importer refuses a disbursement
    // dated before the employee joined AND one dated in the future.
    disbursedOn: '2024-01-01',
    // Every caller passes a period years ahead of 2024-01, which is what the
    // "first deduction is not before disbursement" rule wants. Same month would
    // also be legal; earlier would not.
    firstDeductionPeriod: opts.firstDeductionPeriod,
    installmentsPaid: 0,
    amountRepaid: 0,
    // ACTIVE, CLOSED and ON_HOLD are the three the importer accepts.
    status: 'ACTIVE',
    notes: `${MARK} — ${opts.note}`,
  };
}

interface ImportOutcome {
  referenceNo: string;
  success: boolean;
  loanId?: string;
  error?: string;
}

/** Creates the loans and returns their ids, in the order the rows were given. */
async function importLoans(admin: ApiClient, rows: ImportRowData[]): Promise<string[]> {
  const raw = await admin.post<unknown>('/advance-loans/import/confirm', { rows });
  const box = raw as { results?: ImportOutcome[]; data?: { results?: ImportOutcome[] } } | null;
  const outcomes = box?.results ?? box?.data?.results ?? [];

  const failed = outcomes.filter((o) => !o.success);
  expect(
    failed.length,
    `the loan importer refused ${failed.length}/${rows.length} rows: ` +
      failed
        .slice(0, 3)
        .map((f) => `${f.referenceNo}: ${f.error}`)
        .join(' | '),
  ).toBe(0);

  const ids = outcomes.map((o) => o.loanId).filter((id): id is string => Boolean(id));
  expect(ids.length, 'the importer reported success without returning a loan id').toBe(rows.length);
  return ids;
}

/** Write-offs, run wide rather than deep — 500 sequential POSTs is a teardown nobody waits for. */
async function retireMany(admin: ApiClient, ids: string[], width = 25): Promise<void> {
  for (let i = 0; i < ids.length; i += width) {
    await Promise.allSettled(ids.slice(i, i + width).map((id) => retire(id, admin, admin)));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Payroll setup
// ───────────────────────────────────────────────────────────────────────────

/**
 * Gives a run something to look at, WITHOUT giving the subject any attendance.
 *
 * Two rules of `PayrollsService.create` interact here and both matter:
 *
 *   1. A run where NOBODY has attendance is refused outright ("Attendance for
 *      4/2034 has not been processed yet"), so at least one employee in the run
 *      must have a row.
 *   2. An employee with NO attendance rows at all is treated as FULLY PRESENT
 *      and flagged, because missing data is not evidence of absence.
 *
 * So the pacer carries one attendance day to satisfy (1) — and takes the LOP for
 * it, which is fine because the pacer carries no loans — while the subject is
 * left with nothing and is therefore paid in full under (2), which is what makes
 * an instalment affordable. Seeding a full month of attendance for the subject
 * would do the same thing in twenty-two calls instead of one.
 */
async function pace(admin: ApiClient, pacerId: string, period: { month: number; year: number }): Promise<void> {
  const day = `${period.year}-${String(period.month).padStart(2, '0')}-02`;
  await admin
    .post('/attendances/manual', {
      employeeId: pacerId,
      date: day,
      checkIn: `${day}T09:00:00.000Z`,
      checkOut: `${day}T18:00:00.000Z`,
      status: 'PRESENT',
      notes: `${MARK} pacer day`,
    })
    .catch(() => undefined);
}

/** DRAFT → PENDING_APPROVAL → APPROVED. `lock` refuses anything else. */
async function approveRun(admin: ApiClient, payrollId: string): Promise<void> {
  await admin.post(`/payrolls/${payrollId}/submit`, {});
  await admin.post(`/payrolls/${payrollId}/approve`, { notes: `${MARK} approved for the race` });
}

// ───────────────────────────────────────────────────────────────────────────
// Timing
// ───────────────────────────────────────────────────────────────────────────

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await fn();
  const ms = Date.now() - started;
  // Logged rather than only asserted: a budget tells you pass/fail, the number
  // tells you the trend — and the trend is the thing a reader wants when the
  // budget finally does fail.
  console.log(`[loan-scale] ${label}: ${ms} ms`);
  return { ms, value };
}

/**
 * The budgets, and the reason they are as loose as they are.
 *
 * These are NOT performance targets. They are REGRESSION detectors, and the
 * regression they are shaped to detect is a query that has become linear in the
 * size of the loan book — an `include` moved onto the list route, a per-loan
 * `findUnique` inside the recovery planner, a report that stopped using the
 * partial indexes from `20260806120000_loan_v2_concurrent_indexes`. When that
 * happens the numbers do not drift by 30%; they go from ~200ms to tens of
 * seconds, because each of 500 rows buys its own round trip.
 *
 * So every figure below sits an order of magnitude above what a healthy server
 * actually takes, and is chosen so that it CANNOT fail on a slow laptop, a cold
 * JIT, a container sharing a CPU, or the first request after a restart. Please
 * do not "tighten them up because they always pass with plenty of room" — the
 * room is the feature, and a tightened budget here becomes a flaky test that
 * gets skipped, which is strictly worse than no test.
 *
 * If you want to know whether the API got 20% slower, that is a load harness's
 * job, with warm-ups and percentiles and a fixed machine. This is not that.
 */
const BUDGETS = {
  /** One page of 50, with the `{data, meta, summary}` envelope and its aggregates. */
  list: 10_000,
  /** Outstanding-per-employee, recomputed from PAID ledger rows. */
  outstanding: 15_000,
  /** Instalments scheduled for a cycle. */
  emiDue: 15_000,
  /**
   * A full generation: attendance, overtime, reimbursements, salary components
   * and the recovery plan for every loan in the run. Legitimately the slowest
   * thing in the module even when nothing is wrong.
   */
  payroll: 180_000,
  /** Cold Next.js route + auth + the list request, in a real browser. */
  firstPaint: 45_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// §21 — the optimistic lock
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `casVersion` is one `updateMany ... where version = expected` inside the money
 * transaction, and it is the ONLY thing standing between two simultaneous
 * operators and a lost update. Six shapes, one claim each: the loser is refused,
 * and the balance carries exactly one of the two amounts.
 */
test.describe('two operators, one loan: the compare-and-set decides, and the balance moves once', () => {
  let admin: ApiClient;
  let racerA: ApiClient;
  let racerB: ApiClient;
  let subject: TestEmployee | null = null;
  let setupError = '';
  let scratch: string[] = [];

  /** Imports a live loan for the subject and tracks it for teardown. */
  const track = async (opts: { principal?: number; installments?: number; note: string }): Promise<string> => {
    const [id] = await importLoans(admin, [
      importRow({
        employeeCode: subject!.code,
        principal: opts.principal,
        installments: opts.installments,
        firstDeductionPeriod: ym(NEVER_DUE),
        note: opts.note,
      }),
    ]);
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    test.setTimeout(120_000);
    try {
      admin = await ApiClient.as('admin');
      racerA = await ApiClient.as('admin');
      racerB = await ApiClient.as('admin');
      // HO deliberately: these loans are never due, so no run can claim them,
      // and HO's loan book is already non-empty so nothing is disturbed by
      // adding to it. See the header note about E2E-BR2.
      const ho = await branchIdByCode(admin, 'HO');
      admin.withBranch(ho);
      racerA.withBranch(ho);
      racerB.withBranch(ho);
      subject = await makeEmployee(admin, { marker: `${MARK}cas`, branchId: ho });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    await retireMany(admin, scratch);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && subject) {
      await retireAllMarked(admin, MARKER_PREFIX).catch(() => undefined);
      await terminateEmployee(admin, subject.id).catch(() => undefined);
    }
    await admin?.dispose();
    await racerA?.dispose();
    await racerB?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the money operations are an ADMIN/HR surface');
    });

    test('two simultaneous prepayments: one lands, one 409s, and only one is banked', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const id = await track({ note: 'prepay race' });

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/prepay`, { amount: 200, mode: 'BANK', reference: `${MARK}-A` }),
        racerB.post(`/advance-loans/${id}/prepay`, { amount: 200, mode: 'BANK', reference: `${MARK}-B` }),
      ]);
      expectSingleWinner(results, 'two simultaneous prepayments', /409/);

      // THE assertion. A 409 that still let the write through would be a worse
      // bug than no 409 at all, because it would look correct from the outside.
      await expect
        .poll(async () => num((await loanOf(admin, id)).amountRepaid), { timeout: 20_000 })
        .toBe(200);
      expect(
        (await quoteOf(admin, id)).outstandingPrincipal,
        'MONEY: the payoff quote disagrees with the single prepayment that was accepted',
      ).toBe(400);
    });

    test('two simultaneous waivers forgive one amount, not two', async () => {
      const id = await track({ note: 'waive race' });

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/waive`, {
          amount: 100,
          waiveType: 'PRINCIPAL',
          reason: `${MARK} hardship waiver, first approver`,
        }),
        racerB.post(`/advance-loans/${id}/waive`, {
          amount: 100,
          waiveType: 'PRINCIPAL',
          reason: `${MARK} hardship waiver, second approver`,
        }),
      ]);
      expectSingleWinner(results, 'two simultaneous waivers', /409/);

      await expect
        .poll(async () => num((await loanOf(admin, id)).waivedAmount), { timeout: 20_000 })
        .toBe(100);
      expect((await quoteOf(admin, id)).outstandingPrincipal).toBe(500);
    });

    test('two simultaneous write-offs forgive one amount, not two', async () => {
      const id = await track({ note: 'write-off race' });

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/write-off`, {
          amount: 100,
          reason: `${MARK} uncollectable, recorded by the first administrator`,
        }),
        racerB.post(`/advance-loans/${id}/write-off`, {
          amount: 100,
          reason: `${MARK} uncollectable, recorded by the second administrator`,
        }),
      ]);
      expectSingleWinner(results, 'two simultaneous write-offs', /409/);

      await expect
        .poll(async () => num((await loanOf(admin, id)).writtenOffAmount), { timeout: 20_000 })
        .toBe(100);
      expect((await quoteOf(admin, id)).outstandingPrincipal).toBe(500);
    });

    test('closing while somebody prepays the residual settles the loan exactly once', async () => {
      const id = await track({ note: 'close vs prepay' });

      // 0.50 left of 600 — the "EMI rounding leaves a few cents" state, which is
      // the only state where `close` and `prepay` are BOTH legal on the same
      // loan at the same moment. That overlap is the whole point of the case.
      await admin.post(`/advance-loans/${id}/prepay`, { amount: 599.5, mode: 'BANK' });
      expect((await quoteOf(admin, id)).outstandingPrincipal).toBe(0.5);

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/close`, { reason: `${MARK} residual within tolerance` }),
        racerB.post(`/advance-loans/${id}/prepay`, { amount: 0.5, mode: 'CASH' }),
      ]);
      expectSingleWinner(results, 'close racing a prepayment of the residual', /409/);

      // Which of the two settled the last 0.50 is not this spec's business — one
      // routes it to `waivedAmount`, the other to `amountRepaid`. That it was
      // settled ONCE is.
      const after = await loanOf(admin, id);
      const settledTotal =
        num(after.amountRepaid) + num(after.waivedAmount) + num(after.writtenOffAmount);
      expect(
        settledTotal,
        'MONEY: the 600 principal was accounted for more (or less) than exactly once',
      ).toBe(600);
      expect(after.status).toBe('CLOSED');
      expect((await quoteOf(admin, id)).outstandingPrincipal).toBe(0);
    });

    test('two operators pausing at once leave one hold, never a half of each', async () => {
      const id = await track({ note: 'hold vs hold' });

      // This used to race `hold` against `resume` on an ALREADY-HELD loan,
      // because both were legal from ON_HOLD and both compare-and-set the same
      // version. `assertNotHeld` ended that: a second hold on a held loan is now
      // refused outright, so from ON_HOLD only the resume is ever legal and the
      // pair is no longer a contest — worse, if the resume committed first the
      // hold would then read ACTIVE and legitimately succeed, and the shape
      // assertion would fail for a reason that is not a bug.
      //
      // Two holds from ACTIVE contend for real and cannot land that way. Exactly
      // one is accepted whether or not the requests overlap, and the loser is
      // refused either by the compare-and-set (409, they overlapped) or by
      // `assertNotHeld` (the winner had already committed, and "Recovery is
      // paused on this loan" is the correct answer to a hold on a held loan
      // rather than a race refusal).
      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/hold`, { reason: `${MARK} paused by the first operator` }),
        racerB.post(`/advance-loans/${id}/hold`, { reason: `${MARK} paused by the second operator` }),
      ]);
      const race = expectSingleWinner(results, 'two simultaneous holds', /409|Recovery is paused/i);

      const after = await loanOf(admin, id);
      expect(after.status, 'the accepted hold did not pause the loan').toBe('ON_HOLD');
      // Read against WHICH call won rather than against a fixed answer: the
      // order of two simultaneous requests is not a property of this system.
      // The banner and the badge are the same fact and must not disagree — a
      // loan wearing the loser's reason, or half of each, is how an operator
      // learns to distrust the screen.
      expect(
        String(after.holdReason ?? ''),
        'the loan is held under a reason no accepted call supplied',
      ).toContain(race.won[0] ? 'first operator' : 'second operator');

      // A status race must not be able to move money at all.
      expect(num(after.amountRepaid), 'MONEY: a hold race moved the balance').toBe(0);
      expect(num(after.waivedAmount)).toBe(0);
    });

    test('forgiving an instalment while somebody prepays reduces the balance by one of them', async () => {
      const id = await track({ note: 'skip vs prepay' });

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/skip-installment`, {
          installmentNo: 3,
          // FORGIVE, not EXTEND: only the FORGIVE branch moves money, and only
          // the branch that moves money goes through `casVersion`.
          mode: 'FORGIVE',
          reason: `${MARK} instalment 3 forgiven for hardship`,
        }),
        racerB.post(`/advance-loans/${id}/prepay`, {
          amount: 100,
          mode: 'BANK',
          // REDUCE_EMI keeps the instalment COUNT, so the row the other call is
          // aiming at still exists whichever way the race goes and the refusal
          // is about the version rather than about a vanished row.
          recalc: 'REDUCE_EMI',
        }),
      ]);
      expectSingleWinner(results, 'skip-installment racing a prepayment', /409/);

      // With interest NONE the instalment principal is exactly the prepayment,
      // so one number covers both winners — and the sum being 200 would be the
      // double charge this case exists to catch.
      const after = await loanOf(admin, id);
      expect(
        num(after.amountRepaid) + num(after.waivedAmount),
        'MONEY: both the waiver and the prepayment were applied to the same 100',
      ).toBe(100);
      expect((await quoteOf(admin, id)).outstandingPrincipal).toBe(500);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 — idempotency
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The double-submitted payment.
 *
 * `LoanTransaction.idempotencyKey` is UNIQUE, and `prepay` checks it before the
 * transaction so the replay reads as "already recorded" rather than as a 500
 * from a constraint violation. The pre-check alone is a read-then-write and two
 * concurrent retries walk straight past it — which is why the `P2002` catch
 * exists underneath, and why this case has to be concurrent to reach it.
 */
test.describe('the same payment submitted twice at once is banked once', () => {
  let admin: ApiClient;
  let racerA: ApiClient;
  let racerB: ApiClient;
  let subject: TestEmployee | null = null;
  let setupError = '';
  let scratch: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    test.setTimeout(120_000);
    try {
      admin = await ApiClient.as('admin');
      racerA = await ApiClient.as('admin');
      racerB = await ApiClient.as('admin');
      const ho = await branchIdByCode(admin, 'HO');
      admin.withBranch(ho);
      racerA.withBranch(ho);
      racerB.withBranch(ho);
      subject = await makeEmployee(admin, { marker: `${MARK}idem`, branchId: ho });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    await retireMany(admin, scratch);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && subject) {
      await retireAllMarked(admin, MARKER_PREFIX).catch(() => undefined);
      await terminateEmployee(admin, subject.id).catch(() => undefined);
    }
    await admin?.dispose();
    await racerA?.dispose();
    await racerB?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'recording a payment is an ADMIN/HR surface');
    });

    test('one idempotency key posted twice concurrently produces one 2xx, one 409 and one ledger row', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const [id] = await importLoans(admin, [
        importRow({
          employeeCode: subject!.code,
          firstDeductionPeriod: ym(NEVER_DUE),
          note: 'idempotency race',
        }),
      ]);
      scratch.push(id);

      // `PrepayLoanDto.idempotencyKey` is `@IsUUID()`, so a readable marker
      // string is refused by the validation pipe as a 400 and BOTH racers lose
      // — which reads exactly like a missing concurrency guard. A real v4 key
      // is the only shape the endpoint will look at.
      const key = randomUUID();
      const body = { amount: 150, mode: 'BANK', reference: `${MARK}-utr`, idempotencyKey: key };

      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${id}/prepay`, body),
        racerB.post(`/advance-loans/${id}/prepay`, body),
      ]);
      // Either guard may be the one that fires — the key pre-check, the unique
      // index underneath it, or `casVersion` if the retry got that far. All
      // three answer 409, which is the contract this asserts; which one it was
      // is an implementation detail the caller must not have to know.
      expectSingleWinner(results, 'the same idempotency key posted twice at once', /409/);

      await expect
        .poll(async () => num((await loanOf(admin, id)).amountRepaid), { timeout: 20_000 })
        .toBe(150);

      const ledger = await transactionsOf(admin, subject!.id, id);
      expect(
        countTxns(ledger, 'PREPAYMENT'),
        'MONEY: the retried payment was written to the ledger twice — the employee was charged once and credited twice',
      ).toBe(1);

      // The key stays spent afterwards. Without this the guard would only be a
      // race-window guard, and the ordinary case — a user hitting Retry ten
      // seconds later — would post the payment a second time.
      await expect(
        admin.post(`/advance-loans/${id}/prepay`, body),
        'a settled idempotency key was accepted again',
      ).rejects.toThrow(/already been recorded|409/);
      expect(num((await loanOf(admin, id)).amountRepaid)).toBe(150);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 — the approval race
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Two approvers, one queue.
 *
 * `applyApproved` guards the transition with `updateMany ... where status =
 * 'PENDING'` and refuses the loser, which is the right shape. What only a
 * concurrent test can show is the CONSEQUENCE of that guard being right:
 * `schedules.generate` runs AFTER it, so exactly one plan exists. A second
 * approval slipping through would produce a loan whose schedule has twice the
 * instalments it agreed to, and every payroll after that would recover double.
 *
 * The subject is a SEEDED account, not a `makeEmployee` one, because only the
 * requester can file a request and an API-created employee has no usable
 * password. `ensureAllowance` keeps this file's own leftovers from starving it.
 */
test.describe('two approvers deciding at once produce one decision and one plan', () => {
  let employee: ApiClient;
  let admin: ApiClient;
  let hr: ApiClient;
  let setupError = '';
  let scratch: string[] = [];

  /** A PENDING request — `liveLoan` would approve it, which is the thing under test. */
  const filePending = async (amount: number, installments: number, note: string): Promise<string> => {
    await ensureAllowance(employee, admin, amount, MARKER_PREFIX);
    const created = await employee.post<{ id: string }>('/advance-loans', {
      type: 'LOAN',
      amount,
      installments,
      reason: `${MARK} — ${note}`,
    });
    scratch.push(created.id);
    return created.id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    test.setTimeout(120_000);
    try {
      employee = await ApiClient.as('employee');
      admin = await ApiClient.as('admin');
      // A genuinely different session and token: `advance_loan_approver_roles`
      // is 'HR_MANAGER,ADMIN', so both of these are real approvers and the race
      // is between two people rather than between one person and themselves.
      hr = await ApiClient.as('hr');
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    for (const id of scratch) await retire(id, employee, admin);
    scratch = [];
  });

  test.afterAll(async () => {
    await employee?.dispose();
    await admin?.dispose();
    await hr?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'approving a loan is an approver surface');
    });

    test('two approvers approving together: one APPROVED, and the schedule is not doubled', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const id = await filePending(400, 4, 'approval race');

      const results = await Promise.allSettled([
        admin.post(`/advance-loans/${id}/approve`, { remarks: `${MARK} approved by admin`, installments: 4 }),
        hr.post(`/advance-loans/${id}/approve`, { remarks: `${MARK} approved by HR`, installments: 4 }),
      ]);

      // Two refusals are legitimate and they mean different things.
      // `applyApproved`'s compare-and-set answers 409 — the losing side of a
      // race, matching casVersion, the idempotency key and the in-flight guard,
      // so a client that retries on 409 retries this too. `decide`'s pre-check
      // answers 400 "Cannot decide a request that is already approved", which is
      // a state error rather than a race: by the time that approver's request
      // was read the decision had already been published.
      expectSingleWinner(
        results,
        'two approvers approving the same request',
        /409|already been processed|already .*(approved|decided)/i,
      );

      const after = await loanOf(admin, id);
      expect(after.status).toBe('APPROVED');
      expect(num(after.installments), 'the agreed instalment count did not survive the race').toBe(4);

      // THE assertion. Two approvals landing would mean two calls to
      // `schedules.generate`, and payroll would then collect eight instalments
      // for a four-instalment loan.
      const live = await scheduleOf(admin, id);
      expect(
        live.length,
        'MONEY: the approved loan carries more instalments than it was approved for — ' +
          'the schedule was generated twice',
      ).toBe(4);
      expect(new Set(live.map((r) => r.installmentNo)).size, 'the plan has duplicate instalment numbers').toBe(4);
      expect(live.reduce((sum, r) => sum + r.principalComponent, 0)).toBeCloseTo(400, 2);
    });

    test('approving while somebody rejects lands exactly one decision', async () => {
      const id = await filePending(300, 3, 'approve vs reject');

      const results = await Promise.allSettled([
        admin.post(`/advance-loans/${id}/approve`, { remarks: `${MARK} approved by admin`, installments: 3 }),
        hr.post(`/advance-loans/${id}/reject`, { remarks: `${MARK} rejected by HR on the same second` }),
      ]);
      const race = expectSingleWinner(
        results,
        'an approval racing a rejection',
        /409|already been processed|already .*(approved|decided|rejected)/i,
      );

      const after = await loanOf(admin, id);
      expect(
        after.status,
        race.won[0]
          ? 'the approval was accepted but the request is not approved'
          : 'the rejection was accepted but the request is not rejected',
      ).toBe(race.won[0] ? 'APPROVED' : 'REJECTED');

      // A rejected request is not debt and must carry no plan; an approved one
      // must. Either half being wrong is a loan payroll would treat as real.
      const live = await scheduleOf(admin, id);
      if (race.won[0]) {
        expect(live.length, 'an approved loan has no repayment plan').toBe(3);
      } else {
        expect(
          live.length,
          'MONEY: a REJECTED request carries a live repayment schedule — payroll has something to collect against a loan that was refused',
        ).toBe(0);
      }
    });

    test('approving while the requester cancels never leaves a cancelled loan with a live plan', async () => {
      const id = await filePending(300, 3, 'approve vs cancel');

      const results = await Promise.allSettled([
        admin.post(`/advance-loans/${id}/approve`, { remarks: `${MARK} approved by admin`, installments: 3 }),
        employee.delete(`/advance-loans/${id}`),
      ]);
      const race = raceOf(results);

      const after = await loanOf(admin, id);
      const live = await scheduleOf(admin, id);

      // The state this detects: an APPROVED loan — one that already has a
      // generated schedule and a DISBURSEMENT ledger row — overwritten with
      // CANCELLED. The employee would keep the money and payroll would never
      // collect it, because CANCELLED is terminal and the recovery planner only
      // reads APPROVED/DISBURSED/ACTIVE.
      //
      // `cancel` used to reach it: a read-then-write that checked
      // `status !== 'PENDING'` and then issued a bare `update({ where: { id } })`,
      // so a cancel that read PENDING before the approval committed won anyway.
      // It now compare-and-sets on `status = 'PENDING'` exactly as approve and
      // reject do, refuses the loser with 409, and only calls `engine.abandon`
      // once the CAS has actually won — so a cancel can no longer land on an
      // approved request, and an approval can no longer generate a schedule
      // against a cancelled one.
      //
      // Kept as an INVARIANT rather than rewritten as an outcome shape, because
      // the outcome shape is genuinely not fixed: a multi-step approval chain
      // lets `decide` return "awaiting the next approval step" — a fulfilled
      // call that decides nothing — alongside a cancel that legitimately wins.
      // What is fixed is that CANCELLED and a live plan cannot coexist.
      expect(
        after.status === 'CANCELLED' && live.length > 0,
        `MONEY: the loan is CANCELLED but still carries ${live.length} live schedule row(s) — ` +
          `an approved, planned loan was overwritten by a cancel that never checked whether it had been ` +
          `approved in the meantime. Outcome was ${race.fulfilled}/2 accepted; refusals: ` +
          `${race.refusals.join(' || ') || 'none'}`,
      ).toBe(false);

      // The complementary half: whatever landed, the status and the plan agree.
      expect(['APPROVED', 'CANCELLED'], `unexpected terminal status ${String(after.status)}`).toContain(
        String(after.status),
      );
      if (after.status === 'APPROVED') {
        expect(live.length, 'an approved loan has no repayment plan').toBe(3);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 — payroll
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The place where a double recovery would actually cost somebody money.
 *
 * Payroll is the only path that moves a loan balance without anybody typing an
 * amount, and it does it in two phases: GENERATE writes PENDING ledger rows and
 * a payslip line, LOCK flips them to PAID and moves the balance. Both phases
 * have a concurrency guard and they are different guards:
 *
 *   • generate is protected by `advance_loan_deductions_schedule_live_uq` — one
 *     LIVE row per planned instalment — plus the loan-level in-flight filter
 *     (`deductions: { none: { status: 'PENDING' } }`) which stops a SECOND run
 *     picking up what an unlocked run already holds. The filter is a
 *     read-then-write; the index is what actually holds when two runs interleave.
 *   • lock is protected by `pg_advisory_xact_lock(hashtextextended(payrollId))`
 *     plus a compare-and-set on the payroll status.
 *
 * Runs are scoped with `employeeIds` to this file's own subjects. A branch-wide
 * run would claim every other loan spec's instalments and strand them behind
 * `assertNoRunInFlight` until this file locked or deleted its run — the exact
 * cross-file failure `finance-loan-lifecycle.spec.ts` documents at length.
 */
test.describe('two payroll runs cannot recover the same instalment', () => {
  let admin: ApiClient;
  let racerA: ApiClient;
  let racerB: ApiClient;
  let tidy: ApiClient;
  let branchId = '';
  let subject: TestEmployee | null = null;
  let pacer: TestEmployee | null = null;
  let setupError = '';

  let scratchLoans: string[] = [];
  let scratchRuns: string[] = [];
  /** Periods this file has generated into, cleared wholesale at the end. */
  const usedPeriods: Array<{ month: number; year: number }> = [];

  const seedLoan = async (period: { month: number; year: number }, note: string): Promise<string> => {
    const [id] = await importLoans(admin, [
      importRow({ employeeCode: subject!.code, firstDeductionPeriod: ym(period), note }),
    ]);
    scratchLoans.push(id);
    return id;
  };

  const prepare = async (period: { month: number; year: number }): Promise<void> => {
    usedPeriods.push(period);
    await clearPayrolls(tidy, branchId, period.month, period.year);
    await pace(admin, pacer!.id, period);
  };

  const runFor = async (
    client: ApiClient,
    period: { month: number; year: number },
  ): Promise<{ id: string; status: string }> => {
    const run = await runPayroll(client, {
      month: period.month,
      year: period.year,
      branchId,
      employeeIds: [subject!.id, pacer!.id],
    });
    scratchRuns.push(run.id);
    return run;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    test.setTimeout(180_000);
    try {
      admin = await ApiClient.as('admin');
      racerA = await ApiClient.as('admin');
      racerB = await ApiClient.as('admin');
      tidy = await ApiClient.as('admin');
      branchId = await ensureBranch(admin, SCALE_BRANCH_CODE, 'PW Loan Scale');
      // Every client is scoped once, here. `withBranch` MUTATES and there is no
      // getter, so re-scoping a shared client mid-race is a header two parallel
      // calls would fight over — separate clients, each pinned once, is the only
      // arrangement that is safe to run concurrently.
      admin.withBranch(branchId);
      racerA.withBranch(branchId);
      racerB.withBranch(branchId);
      tidy.withBranch(branchId);
      subject = await makeEmployee(admin, { marker: `${MARK}pay`, branchId, baseSalary: 60000 });
      pacer = await makeEmployee(admin, { marker: `${MARK}pace`, branchId, baseSalary: 60000 });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    // Runs first: while an unlocked run holds a PENDING instalment,
    // `assertNoRunInFlight` refuses the write-off that retires the loan.
    for (const id of scratchRuns) await deletePayroll(tidy, id).catch(() => undefined);
    scratchRuns = [];
    await retireMany(admin, scratchLoans);
    scratchLoans = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && branchId) {
      for (const period of usedPeriods) {
        await clearPayrolls(tidy, branchId, period.month, period.year).catch(() => undefined);
      }
      await retireAllMarked(admin, MARKER_PREFIX).catch(() => undefined);
      if (subject) await terminateEmployee(admin, subject.id).catch(() => undefined);
      if (pacer) await terminateEmployee(admin, pacer.id).catch(() => undefined);
    }
    await admin?.dispose();
    await racerA?.dispose();
    await racerB?.dispose();
    await tidy?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'generating and locking payroll is an administrative flow');
    });

    test('two runs generated for the same branch and period claim the instalment once', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      test.setTimeout(300_000);

      const period = periodAt(90);
      await prepare(period);
      const loanId = await seedLoan(period, 'double generate, same period');

      const results = await Promise.allSettled([runFor(racerA, period), runFor(racerB, period)]);
      // `uniq_payroll_period_branch_batch_version` is the outer guard here: two
      // runs for one branch and period cannot both exist, so the loser is a 409
      // before the recovery planner is ever reached. That is a stronger answer
      // than the ledger index — but only for the same period, which is why the
      // reconciliation case below races two DIFFERENT periods.
      expectSingleWinner(results, 'two payroll runs for one branch and period', /409|already exists/i);

      const rows = await deductions(admin, loanId);
      const live = pending(rows);
      expect(
        live.length,
        `MONEY: the loan is carried by ${live.length} unlocked payroll deductions — locking both would ` +
          `recover the same instalment twice`,
      ).toBe(1);
      expect(num(live[0].amount)).toBe(100);
      // Nothing moves at generate: the balance is only touched at lock.
      expect(num((await loanOf(admin, loanId)).amountRepaid)).toBe(0);
    });

    test('locking the same run twice recovers the instalment once', async () => {
      test.setTimeout(300_000);

      const period = periodAt(92);
      await prepare(period);
      const loanId = await seedLoan(period, 'double lock');

      const run = await runFor(admin, period);
      await approveRun(admin, run.id);

      const results = await Promise.allSettled([
        racerA.post(`/payrolls/${run.id}/lock`, {}),
        racerB.post(`/payrolls/${run.id}/lock`, {}),
      ]);
      // Two refusals are legitimate and they are different facts. The
      // compare-and-set INSIDE the advisory-locked transaction answers 409
      // ("Payroll is no longer in a lockable state"), which is the losing side
      // of the race and the same code every loan-side guard uses, so one client
      // rule — retry on 409 — covers both halves of the module. The status
      // check ABOVE the transaction still answers 400 ("Payroll already
      // locked"): it is advisory, and by the time it fired the other lock had
      // already committed, which is a state error and not a race.
      expectSingleWinner(
        results,
        'two simultaneous locks on one payroll',
        /409|already locked|lockable state/i,
      );

      // The advisory lock's whole purpose, stated as money.
      await expect
        .poll(async () => num((await loanOf(admin, loanId)).amountRepaid), { timeout: 20_000 })
        .toBe(100);
      expect((await quoteOf(admin, loanId)).outstandingPrincipal).toBe(500);

      const ledger = await transactionsOf(admin, subject!.id, loanId);
      expect(
        countTxns(ledger, 'EMI_RECOVERY'),
        'MONEY: the recovery was mirrored into the money ledger twice — the statement double-counts the instalment',
      ).toBe(1);

      const rows = await deductions(admin, loanId);
      expect(pending(rows).length, 'a locked run left a PENDING deduction behind').toBe(0);
      expect(rows.filter((r) => r.status === 'PAID').length).toBe(1);
    });

    test('an unlocked run holding an instalment refuses every operation that would move the balance', async () => {
      test.setTimeout(300_000);

      const period = periodAt(94);
      await prepare(period);
      const loanId = await seedLoan(period, 'in-flight guard');

      const run = await runFor(admin, period);
      expect(pending(await deductions(admin, loanId)).length, 'the run did not claim the instalment').toBe(1);

      // All three at once, because all three go through the same guard and a
      // guard that only holds for the operation you happened to test first is
      // not a guard.
      const results = await Promise.allSettled([
        racerA.post(`/advance-loans/${loanId}/write-off`, {
          reason: `${MARK} attempting a write-off mid-run`,
        }),
        racerB.post(`/advance-loans/${loanId}/close`, { reason: `${MARK} attempting a close mid-run` }),
        admin.post(`/advance-loans/${loanId}/prepay`, { amount: 50, mode: 'CASH' }),
      ]);
      const race = raceOf(results);
      expect(
        race.fulfilled,
        `an operation was accepted while payroll ${period.month}/${period.year} held a PENDING instalment ` +
          `for this loan — the run has already committed to an amount and the ground moved under it`,
      ).toBe(0);
      for (const refusal of race.refusals) {
        expect(refusal).toMatch(/409/);
        expect(refusal).toMatch(/is in progress and already includes an instalment/i);
      }

      const untouched = await loanOf(admin, loanId);
      expect(num(untouched.amountRepaid)).toBe(0);
      expect(num(untouched.writtenOffAmount)).toBe(0);
      expect(untouched.status).toBe('ACTIVE');

      // The guard is a hold, not a wall: deleting the run releases the loan, and
      // a case that only proved the refusal would not notice a permanent one.
      await deletePayroll(tidy, run.id);
      scratchRuns = scratchRuns.filter((id) => id !== run.id);
      await admin.post(`/advance-loans/${loanId}/prepay`, { amount: 50, mode: 'CASH' });
      expect(num((await loanOf(admin, loanId)).amountRepaid)).toBe(50);
    });

    test('a lock committing while a prepayment is in flight charges the loan for one or the other, never both', async () => {
      test.setTimeout(300_000);

      const period = periodAt(96);
      await prepare(period);
      const loanId = await seedLoan(period, 'lock vs prepay, reverse order');

      const run = await runFor(admin, period);
      await approveRun(admin, run.id);
      expect(pending(await deductions(admin, loanId)).length).toBe(1);

      // The reverse of the previous case: the lifecycle call is not refused
      // because the run is unlocked, it is refused (or not) depending on whether
      // it reads the deduction before or after the lock flips it to PAID. Both
      // landings are legitimate; charging for both is not.
      const results = await Promise.allSettled([
        racerA.post(`/payrolls/${run.id}/lock`, {}),
        racerB.post(`/advance-loans/${loanId}/prepay`, { amount: 50, mode: 'BANK', reference: `${MARK}-race` }),
      ]);
      const race = raceOf(results);

      expect(race.won[0], `the lock itself failed: ${race.refusals.join(' || ')}`).toBe(true);

      const prepaid = race.won[1] ? 50 : 0;
      await expect
        .poll(async () => num((await loanOf(admin, loanId)).amountRepaid), { timeout: 20_000 })
        .toBe(100 + prepaid);

      const ledger = await transactionsOf(admin, subject!.id, loanId);
      expect(
        countTxns(ledger, 'EMI_RECOVERY'),
        'MONEY: the payroll recovery was posted more than once',
      ).toBe(1);
      expect(
        countTxns(ledger, 'PREPAYMENT'),
        race.won[1]
          ? 'MONEY: the accepted prepayment is missing from (or duplicated in) the ledger'
          : 'MONEY: a REFUSED prepayment still reached the ledger',
      ).toBe(race.won[1] ? 1 : 0);
    });

    test('two runs for adjoining periods claim every instalment once, and each payslip agrees with the ledger', async () => {
      test.setTimeout(420_000);

      const first = periodAt(98);
      const second = periodAt(99);
      await prepare(first);
      await prepare(second);
      const loanId = await seedLoan(first, 'reconciliation across two concurrent runs');

      // Two DIFFERENT periods, so the payroll uniqueness constraint does not
      // decide the race and both runs really do plan against the same loan. The
      // later run legitimately sweeps arrears forward (`dueCycleKey <=
      // cycleKey`), so it plans instalment 1 AND instalment 2 while the earlier
      // one plans instalment 1 only — the overlap is instalment 1, and that is
      // what the partial unique index has to arbitrate.
      const results = await Promise.allSettled([runFor(racerA, first), runFor(racerB, second)]);
      const race = raceOf(results);
      expect(
        race.fulfilled,
        `both runs are for different periods and should both be created: ${race.refusals.join(' || ')}`,
      ).toBe(2);

      const rows = await deductions(admin, loanId);
      const live = pending(rows);

      // THE claim, stated at the level the index actually enforces: one live
      // recovery row per planned instalment. `advance_loan_deductions_request_
      // period_uq` covers only schedule-LESS (pre-v2) rows, so for a scheduled
      // loan like this one it is `advance_loan_deductions_schedule_live_uq` that
      // does the arbitrating — worth knowing, because a change that made
      // `scheduleId` nullable here would silently move the guard.
      const perSchedule = new Map<string, number>();
      for (const row of live) {
        const key = row.scheduleId ?? `no-schedule:${row.year}-${row.month}`;
        perSchedule.set(key, (perSchedule.get(key) ?? 0) + 1);
      }
      const doubled = [...perSchedule.entries()].filter(([, n]) => n > 1);
      expect(
        doubled.length,
        `MONEY: ${doubled.length} instalment(s) are held by TWO unlocked runs at once — locking both would ` +
          `recover each of them twice`,
      ).toBe(0);

      // Reconciliation. `skipDuplicates: true` silently drops the row the other
      // run already claimed, and without the restate that follows it the payslip
      // would still show the full deduction: the employee's net reduced by money
      // with no ledger row behind it. Withheld but never credited.
      const runs = results
        .filter((r): r is PromiseFulfilledResult<{ id: string; status: string }> => r.status === 'fulfilled')
        .map((r) => r.value);
      for (const run of runs) {
        const item = await payrollItemFor(admin, run.id, subject!.id);
        expect(item, `run ${run.id} produced no payslip line for the subject`).toBeTruthy();
        const claimed = live
          .filter((row) => row.payrollItemId === String(item!.id))
          .reduce((sum, row) => sum + num(row.amount), 0);
        expect(
          num(item!.advanceLoanDeduction),
          `MONEY: payslip ${String(item!.id)} withholds ${String(item!.advanceLoanDeduction)} but the ledger ` +
            `only holds ${claimed} against it — the difference is deducted from the employee and credited to nobody`,
        ).toBe(claimed);
        expect(num(item!.netSalary), 'a restated payslip ended up with a negative net').toBeGreaterThanOrEqual(0);
      }
    });

    test('an import running while payroll generates corrupts neither', async () => {
      test.setTimeout(300_000);

      const period = periodAt(101);
      await prepare(period);
      const existing = await seedLoan(period, 'import vs payroll: the loan already on the books');

      const arriving = importRow({
        employeeCode: subject!.code,
        principal: 300,
        installments: 3,
        firstDeductionPeriod: ym(period),
        note: 'import vs payroll: the loan arriving mid-run',
      });

      const results = await Promise.allSettled([
        runFor(racerA, period),
        importLoans(racerB, [arriving]),
      ]);
      const race = raceOf(results);
      expect(
        race.fulfilled,
        `neither side should refuse the other — the importer writes new loans and the run reads existing ones: ` +
          `${race.refusals.join(' || ')}`,
      ).toBe(2);

      const importedIds = (results[1] as PromiseFulfilledResult<string[]>).value;
      scratchLoans.push(...importedIds);
      const [importedId] = importedIds;

      // The import is intact: a loan half-written by a concurrent transaction
      // would show up as a missing or short schedule, which is the shape a
      // payroll recovering against it would then get wrong.
      const importedPlan = await scheduleOf(admin, importedId);
      expect(importedPlan.length, 'the concurrently imported loan has no repayment plan').toBe(3);
      expect(importedPlan.reduce((sum, r) => sum + r.principalComponent, 0)).toBeCloseTo(300, 2);
      expect(num((await loanOf(admin, importedId)).amount)).toBe(300);

      // The run is intact: the loan that already existed is claimed exactly
      // once, and whether the arriving one was visible to the planner or not
      // (both are legitimate — it depends which side committed first), it is
      // never claimed twice.
      expect(pending(await deductions(admin, existing)).length).toBe(1);
      expect(pending(await deductions(admin, importedId)).length).toBeLessThanOrEqual(1);

      const run = (results[0] as PromiseFulfilledResult<{ id: string }>).value;
      const item = await payrollItemFor(admin, run.id, subject!.id);
      expect(item, 'the run produced no payslip line for the subject').toBeTruthy();
      const allPending = [
        ...pending(await deductions(admin, existing)),
        ...pending(await deductions(admin, importedId)),
      ];
      const claimed = allPending
        .filter((row) => row.payrollItemId === String(item!.id))
        .reduce((sum, row) => sum + num(row.amount), 0);
      expect(
        num(item!.advanceLoanDeduction),
        'MONEY: the payslip withholds an amount the ledger does not account for',
      ).toBe(claimed);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §21 — bulk
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fifty approvals at once, and the question is cross-contamination.
 *
 * Each approval writes the instalment count it was given onto its own loan and
 * then generates a plan from it. Fifty of those running together is where a
 * shared mutable — a cached settings object, a module-level accumulator, a
 * schedule builder that reads the wrong loan — would show as one loan wearing
 * another loan's tenure. So every request below asks for a DIFFERENT number of
 * instalments, and every plan is checked against the number ITS loan asked for.
 *
 * Gated on `flagFlipAllowed()` because it genuinely needs
 * `loan_max_active_per_employee` raised: only the requester can file a request,
 * every seeded account is capped at two live loans, and there is no route that
 * files fifty on somebody's behalf. A setting that every parallel worker shares
 * is not something a default run may touch.
 */
test.describe('fifty loans approved at once, each with the tenure it asked for', () => {
  let employee: ApiClient;
  let admin: ApiClient;
  let approvers: ApiClient[] = [];
  let setupError = '';
  let filed: string[] = [];

  test.beforeAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    test.setTimeout(300_000);
    try {
      employee = await ApiClient.as('employee');
      admin = await ApiClient.as('admin');
      // Four real sessions rather than fifty: the point is concurrent WRITES on
      // the server, and fifty request contexts would spend the whole budget in
      // TLS handshakes proving nothing extra.
      approvers = await Promise.all([
        ApiClient.as('admin'),
        ApiClient.as('admin'),
        ApiClient.as('hr'),
        ApiClient.as('hr'),
      ]);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    await retireMany(admin, filed);
    filed = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && flagFlipAllowed() && admin) {
      await retireAllMarked(admin, MARKER_PREFIX).catch(() => undefined);
    }
    await employee?.dispose();
    await admin?.dispose();
    for (const client of approvers) await client.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'approving loans is an approver surface');
      test.skip(
        !flagFlipAllowed(),
        'raising loan_max_active_per_employee is environment-wide; run with E2E_ALLOW_FLAG_FLIP=1 against a private database',
      );
    });

    test('all fifty land APPROVED with fifty correct plans and no borrowed tenures', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      test.setTimeout(600_000);

      const COUNT = 50;
      /** 2..6, cycling — distinct enough that a swapped tenure is visible. */
      const tenureOf = (index: number): number => 2 + (index % 5);

      await withSettings(admin, { loan_max_active_per_employee: String(COUNT + 10) }, async () => {
        // Filing is setup, not the subject — but sequentially it is fifty round
        // trips, so it goes wide in batches of ten.
        for (let start = 0; start < COUNT; start += 10) {
          const batch = await Promise.all(
            Array.from({ length: Math.min(10, COUNT - start) }, (_, offset) => {
              const index = start + offset;
              return employee.post<{ id: string }>('/advance-loans', {
                type: 'LOAN',
                amount: 100 * tenureOf(index),
                installments: tenureOf(index),
                reason: `${MARK} — bulk approval subject ${index}`,
              });
            }),
          );
          filed.push(...batch.map((r) => r.id));
        }
        expect(filed.length, 'the fifty requests were not all filed').toBe(COUNT);

        const results = await Promise.allSettled(
          filed.map((id, index) =>
            approvers[index % approvers.length].post(`/advance-loans/${id}/approve`, {
              remarks: `${MARK} bulk approval ${index}`,
              installments: tenureOf(index),
            }),
          ),
        );
        const race = raceOf(results);
        expect(
          race.fulfilled,
          `${COUNT - race.fulfilled} of ${COUNT} concurrent approvals were refused — these are FIFTY ` +
            `DIFFERENT loans and none of them contends with another: ${race.refusals.slice(0, 5).join(' || ')}`,
        ).toBe(COUNT);

        // Checked per loan, against the tenure that loan asked for. A single
        // shared-state bug shows here as one loan wearing its neighbour's plan.
        const wrong: string[] = [];
        for (let index = 0; index < filed.length; index += 1) {
          const id = filed[index];
          const expected = tenureOf(index);
          const record = await loanOf(admin, id);
          const plan = await scheduleOf(admin, id);
          if (String(record.status) !== 'APPROVED') {
            wrong.push(`${id}: status ${String(record.status)}`);
            continue;
          }
          if (num(record.installments) !== expected) {
            wrong.push(`${id}: installments ${String(record.installments)} != ${expected}`);
          }
          if (plan.length !== expected) {
            wrong.push(`${id}: ${plan.length} schedule rows != ${expected}`);
          }
          const planned = plan.reduce((sum, row) => sum + row.principalComponent, 0);
          if (Math.abs(planned - 100 * expected) > 0.05) {
            wrong.push(`${id}: plan totals ${planned} != ${100 * expected}`);
          }
        }
        expect(
          wrong.join('\n  '),
          'MONEY: a concurrently approved loan carries a plan that is not its own',
        ).toBe('');
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §20 — scale
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Two sizes, five surfaces, and one question: has the cost curve changed shape?
 *
 * 10k and 100k are DELIBERATELY not attempted — see the file header. What is
 * here is the smallest pair of sizes that can distinguish "constant-ish" from
 * "linear in the size of the loan book", which is the only performance
 * regression a functional suite can honestly catch.
 *
 * Seeding is via the importer and goes wide: ten batches of fifty rows, five
 * requests in flight at a time. Five hundred sequential awaits would take longer
 * than every assertion in this file put together.
 */
test.describe('the loan book at 100 and at 500', () => {
  let admin: ApiClient;
  let seeder: ApiClient;
  let tidy: ApiClient;
  let branchId = '';
  let staff: TestEmployee[] = [];
  let pacer: TestEmployee | null = null;
  let setupError = '';

  const loans: string[] = [];
  const runs: string[] = [];
  const period = periodAt(120);

  const STAFF = 10;
  /** Six instalments rather than twelve: half the schedule rows, same query shapes. */
  const TENURE = 6;

  /** Adds `count` loans across the staff, in batches, five requests in flight. */
  async function seedLoans(count: number, note: string): Promise<number> {
    const rows: ImportRowData[] = Array.from({ length: count }, (_, index) =>
      importRow({
        employeeCode: staff[index % staff.length].code,
        principal: 600,
        installments: TENURE,
        firstDeductionPeriod: ym(period),
        note: `${note} #${index}`,
      }),
    );

    const batches: ImportRowData[][] = [];
    for (let i = 0; i < rows.length; i += 50) batches.push(rows.slice(i, i + 50));

    const { ms } = await timed(`seed ${count} loans`, async () => {
      for (let i = 0; i < batches.length; i += 5) {
        const wave = await Promise.all(batches.slice(i, i + 5).map((batch) => importLoans(seeder, batch)));
        for (const ids of wave) loans.push(...ids);
      }
    });
    return ms;
  }

  /** The five measurements, taken at whatever size the book currently is. */
  async function measure(size: number): Promise<void> {
    const list = await timed(`GET /advance-loans?page=1&limit=50 @ ${size}`, () =>
      admin.get<unknown>('/advance-loans?page=1&limit=50'),
    );
    expect(
      list.ms,
      `the paginated loan list took ${list.ms}ms at ${size} loans. This budget is an N+1 detector with an ` +
        `order of magnitude of headroom (see BUDGETS) — it does not fail on a slow machine, so a failure ` +
        `here means a per-row query has appeared on the list route.`,
    ).toBeLessThan(BUDGETS.list);

    const outstanding = await timed(`GET /advance-loans/reports/outstanding @ ${size}`, () =>
      admin.get<unknown>('/advance-loans/reports/outstanding?page=1&limit=50'),
    );
    expect(
      outstanding.ms,
      `the outstanding report took ${outstanding.ms}ms at ${size} loans — it recomputes repaid from PAID ` +
        `ledger rows, so a regression here is usually a per-loan aggregate rather than one grouped query.`,
    ).toBeLessThan(BUDGETS.outstanding);

    const emiDue = await timed(`GET /advance-loans/reports/emi-due @ ${size}`, () =>
      admin.get<unknown>(`/advance-loans/reports/emi-due?month=${period.month}&year=${period.year}`),
    );
    expect(
      emiDue.ms,
      `the EMI-due report took ${emiDue.ms}ms at ${size} loans — this is the report ` +
        `idx_loan_schedules_collectable exists for, so a regression here is usually that index no longer ` +
        `being usable (a widened predicate, a changed status set).`,
    ).toBeLessThan(BUDGETS.emiDue);

    await clearPayrolls(tidy, branchId, period.month, period.year);
    const generation = await timed(`POST /payrolls over ${STAFF} staff @ ${size} loans`, () =>
      runPayroll(seeder, {
        month: period.month,
        year: period.year,
        branchId,
        // Scoped to this file's own staff on purpose. A branch-wide run would
        // claim every other loan spec's instalments and strand them behind the
        // in-flight guard; the recovery planner still loads all `size` loans
        // either way, which is where the N+1 risk actually lives.
        employeeIds: [...staff.map((s) => s.id), pacer!.id],
      }),
    );
    runs.push(generation.value.id);
    expect(
      generation.ms,
      `payroll generation took ${generation.ms}ms with ${size} loans in the book. Generation is legitimately ` +
        `the slowest thing in the module — attendance, overtime, reimbursements, salary components and the ` +
        `recovery plan for every loan — so this budget is deliberately three minutes. It fails when the ` +
        `recovery planner starts querying per loan instead of per chunk.`,
    ).toBeLessThan(BUDGETS.payroll);
  }

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    test.setTimeout(600_000);
    try {
      admin = await ApiClient.as('admin');
      seeder = await ApiClient.as('admin');
      tidy = await ApiClient.as('admin');
      branchId = await ensureBranch(admin, SCALE_BRANCH_CODE, 'PW Loan Scale');
      admin.withBranch(branchId);
      seeder.withBranch(branchId);
      staff = [];
      for (let index = 0; index < STAFF; index += 1) {
        staff.push(
          await makeEmployee(admin, {
            marker: `${MARK}s${index}`,
            branchId,
            baseSalary: 90000,
          }),
        );
      }
      pacer = await makeEmployee(admin, { marker: `${MARK}space`, branchId, baseSalary: 60000 });
      await pace(admin, pacer.id, period);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && branchId) {
      test.setTimeout(600_000);
      // Runs first — an unlocked run holding an instalment refuses the write-off
      // that retires the loan it is holding.
      for (const id of runs) await deletePayroll(tidy, id).catch(() => undefined);
      await clearPayrolls(tidy, branchId, period.month, period.year).catch(() => undefined);
      await retireMany(admin, loans, 25);
      for (const member of [...staff, ...(pacer ? [pacer] : [])]) {
        await terminateEmployee(admin, member.id).catch(() => undefined);
      }
    }
    await admin?.dispose();
    await seeder?.dispose();
    await tidy?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the loan book and payroll are administrative surfaces');
    });

    test('100 loans: the list, both reports and a payroll run stay inside budget', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      test.setTimeout(900_000);

      await seedLoans(100, 'scale seed');
      expect(loans.length, 'the 100-loan seed did not produce 100 loans').toBe(100);
      await measure(100);
    });

    test('500 loans: the same five surfaces, five times the book', async () => {
      test.setTimeout(900_000);

      await seedLoans(400, 'scale seed');
      expect(loans.length, 'the 500-loan seed did not produce 500 loans').toBe(500);
      await measure(500);
    });

    test('the list screen still paints its result count with 500 loans behind it', async ({
      page,
      problems,
    }) => {
      test.setTimeout(300_000);
      expect(loans.length, 'the scale seed did not run, so there is nothing to paint').toBe(500);

      await selectBranch(page, branchId);
      const list = new AdvanceLoansPage(page);
      const toolbar = new LoanToolbar(page);

      const started = Date.now();
      await list.open();
      await list.openTab('all');

      // First paint is defined as the moment the toolbar can answer "how many
      // matched?" — `data-total` resolving is the server having answered AND the
      // screen having rendered it, which is the thing a user waits for. The
      // count itself is read as an attribute rather than out of the four-shaped
      // English sentence beside it.
      await expect
        .poll(async () => {
          const count = await toolbar.count();
          return !count.loading && count.total > 0;
        }, { timeout: BUDGETS.firstPaint })
        .toBe(true);
      const ms = Date.now() - started;
      console.log(`[loan-scale] loan list first paint @ 500 loans: ${ms} ms`);

      const count = await toolbar.count();
      expect(
        count.total,
        'the list reported fewer loans than this file alone seeded, so the total is not a server-side count',
      ).toBeGreaterThanOrEqual(500);
      // One page, not five hundred rows: a screen that renders the whole book
      // is the front-end half of the same regression the API budgets watch for.
      expect(count.shown, 'the list rendered the entire book instead of one page').toBeLessThanOrEqual(100);
      expect(count.shown).toBeGreaterThan(0);

      expect(
        ms,
        `the loan list took ${ms}ms to paint its count with 500 loans behind it. Same reasoning as the API ` +
          `budgets: this is a regression detector with an order of magnitude of headroom, not a performance ` +
          `target, and tightening it turns it into a flake.`,
      ).toBeLessThan(BUDGETS.firstPaint);

      settle(problems, 'the loan list with a five-hundred-loan book');
    });
  });
});
