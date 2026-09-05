import { test, expect, settle, ApiClient } from '../../fixtures';
import { LoanLifecyclePage, selectBranch } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  clearPayrolls,
  deductionsFor,
  deletePayroll,
  flagFlipAllowed,
  loanOf,
  lockPayroll,
  makeEmployee,
  marker,
  payrollItemFor,
  retireAllMarked,
  runPayroll,
  scheduleOf,
  terminateEmployee,
  unlockPayroll,
  withSettings,
  type TestEmployee,
} from '../../loan-support';

/**
 * The money path: what payroll actually TAKES off an employee's salary for a
 * loan, and when that money really moves.
 *
 * Everything else in the loan suite is about a decision — who may approve, who
 * may forgive, what the screen offers. This file is about arithmetic that ends
 * up in somebody's bank account, and about the two moments where a mistake is
 * expensive: GENERATION, which decides the figure and reserves the instalment,
 * and LOCK, which is the only place `amountRepaid` moves at all.
 *
 * ## Why this is an e2e file and not more unit tests
 *
 * `payrolls-advance-loan.spec.ts` and `loan-recovery.service.spec.ts` already
 * table-test the allocator with a stubbed Prisma. They prove the FUNCTION. They
 * cannot prove that the same rules survive the trip through
 * `LoanPolicyService.resolve()` (which reads `SystemSetting`), through
 * `PayrollsService.create()` (which computes the net the allocator divides up),
 * through `applyLock()` (which turns a plan into balances) and back out of
 * `GET /advance-loans/:id` to a user. Every case below is the same rule asked
 * over HTTP, of a real database, with real settings.
 *
 * ## The kill-switch, which decides what is even reachable
 *
 * `loan_module_v2_enabled` is `'false'` — pinned that way in
 * `seed-e2e-baseline.ts`. With it OFF `allocateForEmployee` returns early and
 * recovers EVERY due instalment IN FULL: no affordability cap, no protected
 * take-home, no leave pause, no run-type gate. So the shipped behaviour and the
 * v2 matrix are two different systems, and this file covers both:
 *
 *   • The describes that need no flag are the SHIPPED behaviour, and they run on
 *     every invocation. They also carry everything the switch does not touch —
 *     the ON_HOLD query filter, the arrears sweep, the in-flight guard, the
 *     legacy bridge, lock, delete, unlock and revision — because those are the
 *     same code either way, and gating them on an env var would leave the most
 *     expensive assertions in the suite unrun by default.
 *   • The affordability, leave and multi-loan describes flip
 *     `loan_module_v2_enabled` and are skipped unless `E2E_ALLOW_FLAG_FLIP=1`,
 *     for the reason `approval-chain.spec.ts` states: a system setting is shared
 *     by every worker, and flipping the master loan switch mid-suite re-routes
 *     recovery for every other loan spec running in parallel.
 *
 * ## Why E2E-BR2 and not HO
 *
 * `docs/TEST-PLAN-FINANCE.md` §7.7 (F35) records the collision: a payroll run is
 * generated for a whole BRANCH, and the recovery planner selects
 * `dueCycleKey <= cycleKey`, so a far-future run claims **every live loan in the
 * branch** — including one another spec created seconds earlier. Once claimed,
 * `assertNoRunInFlight` refuses every operation on that loan, tidy-up included.
 * `payroll-depth.admin-employee.spec.ts`, `payroll.admin-employee.spec.ts` and
 * `wps.admin.spec.ts` all run against `HO`. This file therefore runs on
 * `E2E-BR2`, in periods ~8-10 years out that nothing else reaches, and it always
 * passes `employeeIds` so a run covers only the employees it created.
 *
 * ## The fixtures, and why they are built rather than borrowed
 *
 * Two facts force it. The seeded employees have `baseSalary: 0`, so a payroll
 * run produces nothing to recover FROM — every case would pass by recovering
 * zero. And `POST /advance-loans` files a request for the CALLER's own employee
 * record only, while `makeEmployee` cannot hand back a login (see `NO_LOGIN` in
 * `loan-support.ts`). So:
 *
 *   • employees come from `makeEmployee({ baseSalary })`, which works — payroll
 *     net derives straight from `employee.baseSalary`;
 *   • loans come from `POST /advance-loans/import/confirm`, the ADMIN bulk path.
 *     It takes the rows a preview would have produced, runs them through the
 *     SAME amortization engine as the normal flow, and needs no session for the
 *     borrower. It is also the only way to reach three states this file needs:
 *     a mid-life loan whose live schedule is empty (the legacy bridge), an
 *     ON_HOLD loan, and more live loans than `loan_max_active_per_employee`.
 *
 * ## The twin, which is what makes the arithmetic assertable
 *
 * Net pay is `base + allowances - PF - professional tax - ESI - income tax`, and
 * every one of those is configurable. A spec that predicted a number from
 * `baseSalary` would be asserting the tax tables. So every run also includes
 * `twin` — an employee identical to the subject in every respect EXCEPT that it
 * owes nothing — and `twin.netSalary` IS `netPreRecovery`. The pool formula is
 * then re-derived in the spec from that observed figure:
 *
 *     protectedNet = max(minNetPayAmount, netPre * minNetPayPercent / 100)
 *     capByPercent = netPre * maxTotalDeductionPercentOfNet / 100
 *     pool         = max(0, min(netPre - protectedNet, capByPercent))
 *
 * and the recovered amount is asserted against it. The twin doubles as the
 * reconciliation control: `subject.netSalary + subject.advanceLoanDeduction`
 * must equal `twin.netSalary` exactly, or the payslip does not add up.
 *
 * ## The attendance carrier
 *
 * `PayrollsService.create` refuses a period in which NO targeted employee has an
 * attendance row ("Attendance … has not been processed yet") — otherwise
 * everyone counts absent and LOP wipes the run. It also skips LOP for any
 * employee with no attendance at all, which is exactly what the subjects want:
 * full pay, no proration, nothing to explain. So one throwaway employee gets a
 * single attendance day per period to satisfy the run-level guard, and nobody
 * else gets any.
 *
 * ## Three things that are NOT reachable over HTTP, and are skipped by name
 *
 *   1. `AdvanceLoanRequest.priority` has no write surface on any DTO — it is
 *      always the schema default of 100 — so "a per-request priority overrides
 *      the type order" cannot be set up.
 *   2. `LibraryItem.loanDeductionPolicy` is read by payroll but is absent from
 *      `CreateLibraryItemDto`/`UpdateLibraryItemDto` and unset by the seed, so
 *      per-leave-type CONTINUE/EXTEND/PAUSE — and therefore strictest-wins
 *      across two overlapping types — cannot be configured.
 *   3. `loan_priority_tiebreak` is writable but is NOT returned by
 *      `GET /system-settings`, so `withSetting` refuses it (it will not restore
 *      a guess). Only its default, `OLDEST_FIRST`, is asserted.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half of the marker — what identifies a record as THIS file's. */
const MARKER_PREFIX = 'pw-loanpay-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const MARK = marker(MARKER_PREFIX);

const BRANCH_CODE = 'E2E-BR2';

/**
 * The salary every subject and the twin are paid.
 *
 * Big enough that a 50 % pool is comfortably above `loan_min_partial_recovery_amount`,
 * and round enough that a failure message is readable. The absolute net it
 * produces is never assumed — it is measured once, in `beforeAll`.
 */
const SALARY = 40000;

interface Period {
  month: number;
  year: number;
}

/**
 * A period nothing else in the suite reaches.
 *
 * `payroll.admin-employee.spec.ts` picks 1-24 months out, `wps.admin.spec.ts`
 * 25-48 and `payroll-depth.admin-employee.spec.ts` 30-48. Starting at 96 leaves
 * four years of clear air, and the per-run jitter means a Playwright retry —
 * which restarts the worker and resets the counter — lands on a fresh block
 * instead of colliding with the runs the failed attempt left behind.
 */
const PERIOD_BASE = 96 + (Date.now() % 24);
let periodCursor = 0;

function periodAt(monthsForward: number): Period {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + monthsForward);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

/** Numeric cycle key, the same one `LoanRecoveryService` sorts arrears by. */
const cycleKey = (p: Period): number => p.year * 12 + p.month;

/** `YYYY-MM`, the shape the loan importer wants for a first deduction month. */
const periodKey = (p: Period): string => `${p.year}-${String(p.month).padStart(2, '0')}`;

// ───────────────────────────────────────────────────────────────────────────
// Shapes the server actually returns
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row of `advance_loan_deductions`, as `GET /advance-loans/:id` includes it.
 *
 * Every money column is a STRING: they are `Decimal(12,2)` and Prisma serialises
 * them that way. Comparing one to a number without `Number()` silently fails.
 */
interface DeductionRow {
  id: string;
  requestId: string;
  scheduleId: string | null;
  payrollItemId: string | null;
  amount: string;
  principalComponent: string;
  interestComponent: string;
  feeComponent: string;
  plannedAmount: string | null;
  shortfallAmount: string;
  outcome: string | null;
  reason: string | null;
  month: number;
  year: number;
  status: string;
  /** Stamped only by `unlockPayroll`, so it is the proof a reversal happened. */
  reversedAt: string | null;
}

/** One money event on the loan, from the per-employee statement. */
interface StatementTxn {
  type: string;
  amount: string | number;
  principalComponent: string | number | null;
  interestComponent: string | number | null;
  narration: string | null;
}

interface StatementLoan {
  id: string;
  transactions?: StatementTxn[];
}

/** Decimal columns cross the wire as strings; this is the one place that admits it. */
const n = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** The backend's own 2dp rounding, so a spec-computed figure is comparable. */
const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

// ───────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ───────────────────────────────────────────────────────────────────────────

let adminApi: ApiClient;
let hrApi: ApiClient;
let branchId = '';
let setupError = '';

/** Carries the single attendance row that keeps `create()` from refusing. */
let carrier: TestEmployee;
/** Identical to every subject except that it owes nothing. Measures net pay. */
let twin: TestEmployee;
/** The subject of the single-loan describes. */
let borrower: TestEmployee;
/** The subject of the leave describe — its approved leaves must not leak. */
let leaver: TestEmployee;
/** The subject of the multi-loan describe. */
let juggler: TestEmployee;
/** Paid nothing at all, for the zero-net cycle. */
let pauper: TestEmployee;

/**
 * Net pay for one uninterrupted cycle at `SALARY`, measured rather than assumed.
 *
 * Every affordability figure in this file is derived from it, so the tax
 * configuration of the environment cannot make an assertion wrong — only
 * `SALARY` and the loan policy can.
 */
let NET = 0;

/** Periods this test reserved, cleared in `afterEach`. */
let periodsInFlight: Period[] = [];

/** Reserves `count` consecutive untouched periods and remembers them for teardown. */
function reserve(count = 1): Period[] {
  const out: Period[] = [];
  for (let i = 0; i < count; i++) out.push(periodAt(PERIOD_BASE + periodCursor++));
  periodsInFlight.push(...out);
  return out;
}

/**
 * One attendance day for the carrier.
 *
 * The run-level guard counts rows of ANY status for the targeted employees, so
 * one row is enough — and giving it to nobody else is what keeps every subject
 * on `attendanceMissing`, which skips LOP entirely and leaves net pay a clean
 * function of `baseSalary`.
 */
async function seedCarrierAttendance(p: Period): Promise<void> {
  const day = `${p.year}-${String(p.month).padStart(2, '0')}-02`;
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
}

/**
 * Generates ONE payroll run over exactly the employees named, plus the carrier
 * and the twin.
 *
 * The twin rides along on every run on purpose: its `netSalary` is the
 * `netPreRecovery` the allocator divided up, and there is no other way to learn
 * that figure from outside the server.
 */
async function generate(
  p: Period,
  subjects: string[],
  opts: { runType?: string } = {},
): Promise<{ id: string; status: string }> {
  await seedCarrierAttendance(p);
  const run = await runPayroll(adminApi, {
    month: p.month,
    year: p.year,
    branchId,
    runType: opts.runType,
    employeeIds: [carrier.id, twin.id, ...subjects],
  });
  return { id: run.id, status: run.status };
}

/** DRAFT → PENDING_APPROVAL → APPROVED, the only route to a lockable run. */
async function approveRun(payrollId: string): Promise<void> {
  await adminApi.post(`/payrolls/${payrollId}/submit`, {});
  await adminApi.post(`/payrolls/${payrollId}/approve`, { notes: `${MARK} approved` });
}

/** Generate, approve and lock in one go — the whole money-moving sequence. */
async function generateAndLock(
  p: Period,
  subjects: string[],
  opts: { runType?: string } = {},
): Promise<string> {
  const run = await generate(p, subjects, opts);
  await approveRun(run.id);
  await lockPayroll(adminApi, run.id);
  return run.id;
}

/** `netPreRecovery` for this run, read off the employee who owes nothing. */
async function netPreRecovery(payrollId: string): Promise<number> {
  const item = await payrollItemFor(adminApi, payrollId, twin.id);
  expect(item, 'the twin was not in the run, so net pre-recovery is unknowable').toBeTruthy();
  return n(item!.netSalary);
}

/** Every ledger row on this loan, newest first, as the detail route returns them. */
async function rows(loanId: string): Promise<DeductionRow[]> {
  return (await deductionsFor(adminApi, loanId)) as DeductionRow[];
}

/** The ledger rows this loan collected in one cycle. */
async function rowsIn(loanId: string, p: Period): Promise<DeductionRow[]> {
  return (await rows(loanId)).filter((r) => r.month === p.month && r.year === p.year);
}

/** A ledger row named the way a failure needs to read it. */
const describeRow = (r: DeductionRow): string =>
  `{scheduleId: ${r.scheduleId ?? 'null'}, status: ${r.status}, amount: ${r.amount}, ` +
  `outcome: ${r.outcome ?? 'null'}, reason: ${r.reason ?? 'null'}}`;

/** A row that actually moved money, as opposed to an explanatory line. */
const isMoneyRow = (r: DeductionRow): boolean =>
  ['PENDING', 'PAID', 'PARTIAL'].includes(r.status) && n(r.amount) > 0;

/**
 * The one ledger row this loan produced in this cycle, once the server has
 * written it. Polled because payroll generation is slow and the brief says so.
 *
 * `rowsIn` filters on month/year ALONE, and one loan can legitimately put more
 * than one row into one cycle:
 *
 *   • a zero-amount line is written as SKIPPED (`payrolls.service.ts:820`) to
 *     record WHY nothing was taken, and it shares the period with whatever else
 *     the loan did that month — so `found[0]` off a newest-first list was
 *     picking between them by luck;
 *   • the arrears sweep (`loan-recovery.service.ts:182`, `dueCycleKey <=
 *     cycleKey`) hands one run every instalment that is due OR overdue, each
 *     with its own `scheduleId`.
 *
 * The first is disambiguated here — the money row wins over the explanatory
 * ones. The second is NOT: two live instalments in one cycle is either a
 * deliberate arrears sweep or a genuine double-deduction, and the two look
 * identical as a count, so the failure lists every row it saw rather than
 * reporting a number. A test that means to collect arrears uses `rowsIn`.
 */
async function rowIn(loanId: string, p: Period): Promise<DeductionRow> {
  await expect
    .poll(async () => (await rowsIn(loanId, p)).length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  const found = await rowsIn(loanId, p);
  const money = found.filter(isMoneyRow);
  const chosen = money.length > 0 ? money : found;
  expect(
    chosen.length,
    `expected one ledger row for ${p.month}/${p.year}, saw ${found.length}: ` +
      found.map(describeRow).join(' '),
  ).toBe(1);
  return chosen[0];
}

// ───────────────────────────────────────────────────────────────────────────
// The loan fixture factory
// ───────────────────────────────────────────────────────────────────────────

let loanSeq = 0;

interface ImportedLoanOpts {
  employee: TestEmployee;
  type?: 'ADVANCE' | 'LOAN';
  principal: number;
  installments?: number;
  /** The cycle instalment 1 falls due in. Every later one is a month on. */
  firstDue: Period;
  /** Instalments the import marks already settled — they get PAID schedule rows. */
  installmentsPaid?: number;
  /** Principal already repaid. Below the consumed principal, the live plan empties. */
  amountRepaid?: number;
  status?: 'ACTIVE' | 'ON_HOLD';
  interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  interestRate?: number;
  note: string;
}

/**
 * Creates a live, recoverable loan for an employee nobody can log in as.
 *
 * `POST /advance-loans/import/confirm` takes the row objects a preview would
 * have produced and creates the loan directly — same amortization engine, same
 * schedule rows, same `advance_loan_deductions` history for the instalments the
 * row says are already paid. It bypasses approval (imported loans were approved
 * elsewhere) and the eligibility engine, which is what makes a three-loan
 * employee and a loan whose EMI exceeds their whole salary constructible at all.
 *
 * What it does NOT bypass is `validateImportRow`, which `confirm` now runs over
 * every row exactly as `preview` does. That is a row-shape check, not a policy
 * one — there is still no principal ceiling and a tenure over
 * `loan_max_installments` is a warning — but it does bind the fields below:
 * `status` is one of ACTIVE/CLOSED/ON_HOLD, `disbursedOn` is a real past date
 * not before the employee joined, `firstDue` is a real month not earlier than
 * `disbursedOn` (the same month is fine), money carries at most two decimals,
 * and `interestMethod` must be NONE unless `loan_interest_enabled` is on. Every
 * default here satisfies all of them; the one case that passes `FLAT` says how
 * it earns the exception.
 *
 * The marker goes into `notes`, which the importer stores as `reason` — the only
 * field `retireAllMarked` can identify this file's loans by.
 */
async function importLoan(opts: ImportedLoanOpts): Promise<string> {
  const type = opts.type ?? 'LOAN';
  const installments = type === 'ADVANCE' ? 1 : (opts.installments ?? 1);
  const reference = `LN-${MARK}-${++loanSeq}`.toUpperCase();

  const res = await adminApi.post<{
    summary: { imported: number; failed: number };
    results: Array<{ success: boolean; loanId?: string; error?: string }>;
  }>('/advance-loans/import/confirm', {
    rows: [
      {
        employeeCode: opts.employee.code,
        referenceNo: reference,
        type,
        principal: opts.principal,
        interestMethod: opts.interestMethod ?? 'NONE',
        interestRate: opts.interestRate ?? 0,
        installments,
        emi: null,
        // Comfortably after the 2020-01-01 start date `makeEmployee` uses and
        // comfortably in the past, so the row clears both halves of the rule —
        // not before the employee joined, and not in the future — without
        // depending on when the suite happens to run.
        disbursedOn: '2024-01-15',
        firstDeductionPeriod: periodKey(opts.firstDue),
        installmentsPaid: opts.installmentsPaid ?? 0,
        amountRepaid: opts.amountRepaid ?? 0,
        status: opts.status ?? 'ACTIVE',
        notes: `${MARK} — ${opts.note}`,
      },
    ],
  });

  const first = res.results?.[0];
  expect(first?.success, `loan import failed: ${first?.error ?? 'no result row'}`).toBe(true);
  return first!.loanId!;
}

// ───────────────────────────────────────────────────────────────────────────
// Setup and teardown
// ───────────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!isProject('admin')) return;
  try {
    adminApi = await ApiClient.as('admin');
    hrApi = await ApiClient.as('hr');
    branchId = await branchIdByCode(adminApi, BRANCH_CODE);
    adminApi.withBranch(branchId);
    hrApi.withBranch(branchId);

    const mk = (suffix: string, baseSalary: number) =>
      makeEmployee(adminApi, { marker: `${MARK}${suffix}`, baseSalary, branchId });

    carrier = await mk('carrier', 1000);
    twin = await mk('twin', SALARY);
    borrower = await mk('borrower', SALARY);
    leaver = await mk('leaver', SALARY);
    juggler = await mk('juggler', SALARY);
    pauper = await mk('pauper', 0);

    // ── Calibration ───────────────────────────────────────────────────────
    // One throwaway run with nobody owing anything, purely to learn what an
    // uninterrupted cycle at SALARY nets. Every affordability figure below is
    // computed from this, so no assertion in this file depends on the tax,
    // PF or ESI configuration of the environment it runs in.
    const [cal] = reserve();
    const calRun = await generate(cal, []);
    NET = await netPreRecovery(calRun.id);
    await deletePayroll(adminApi, calRun.id);
    periodsInFlight = [];

    if (NET <= 0) {
      setupError =
        `the calibration run netted ${NET} for baseSalary ${SALARY} — every recovery ` +
        `assertion in this file would be vacuous`;
    }
  } catch (e) {
    setupError = (e as Error).message;
  }
});

/**
 * Teardown, in the one order that works.
 *
 * Payrolls first: while an UNLOCKED run holds a PENDING instalment,
 * `assertNoRunInFlight` refuses every operation on that loan — write-off
 * included — so retiring loans first silently does nothing and the next test
 * inherits a live loan that recovers again.
 *
 * Periods are cleared NEWEST first because `unlockPayroll` answers 409 when a
 * LATER run has already recovered against the same loans; reversing out of order
 * is exactly what that guard exists to prevent.
 */
test.afterEach(async () => {
  if (!isProject('admin')) return;
  const ordered = [...periodsInFlight].sort((a, b) => cycleKey(b) - cycleKey(a));
  periodsInFlight = [];
  for (const p of ordered) {
    await clearPayrolls(adminApi, branchId, p.month, p.year).catch(() => undefined);
  }
  await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
});

test.afterAll(async () => {
  if (isProject('admin')) {
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    for (const emp of [carrier, twin, borrower, leaver, juggler, pauper]) {
      if (emp?.id) await terminateEmployee(adminApi, emp.id).catch(() => undefined);
    }
  }
  await adminApi?.dispose();
  await hrApi?.dispose();
});

// ───────────────────────────────────────────────────────────────────────────
// 1. What payroll takes with the module in its shipped state (v2 OFF)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The behaviour a customer has today.
 *
 * With `loan_module_v2_enabled` false the allocator returns before it has looked
 * at net pay, leave or run type, so every due instalment is taken in full. That
 * is not a bug — it is the kill-switch doing precisely what a kill-switch is
 * for — but it IS the behaviour, and a suite that only tested the v2 matrix
 * would be testing a system nobody is running.
 */
test.describe('with the loan module in its shipped state, every due instalment is taken in full', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll generation is an administrative flow');
  });

  test('an instalment larger than the whole net pay is still recovered in full', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const [p] = reserve();
    // An EMI far above anything the employee takes home. Constructible only
    // through the importer: `POST /advance-loans` runs NET_PAY_AFTER_EMI, which
    // caps a new instalment at 50 % of monthly pay.
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'v2 off — EMI above net',
    });

    const run = await generate(p, [borrower.id]);
    const row = await rowIn(loanId, p);

    // The claim, stated as the numbers: the deduction is the whole EMI, the
    // allocator called it AFFORDABLE without consulting net pay, and nothing was
    // carried forward. Turning v2 ON changes every one of these three — see
    // 'part-pays what it can afford' below, which is the same setup with the
    // switch flipped.
    expect(n(row.amount)).toBeCloseTo(emi, 2);
    expect(row.outcome).toBe('FULL');
    expect(row.reason).toBe('AFFORDABLE');
    expect(n(row.shortfallAmount)).toBe(0);

    const item = await payrollItemFor(adminApi, run.id, borrower.id);
    expect(n(item?.advanceLoanDeduction)).toBeCloseTo(emi, 2);
    // Net floors at zero — you do not collect money back through a payslip —
    // so the employee is paid nothing this month and still owes the remainder.
    expect(n(item?.netSalary)).toBe(0);
    expect(emi, 'the fixture no longer exceeds net pay, so this proves nothing').toBeGreaterThan(NET);
  });

  test('a BONUS run recovers too, because the run-type gate is a v2 rule', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 2,
      firstDue: p,
      note: 'v2 off — bonus run',
    });

    // `loan_recover_on_run_types` defaults to REGULAR,FINAL_SETTLEMENT and BONUS
    // is not in it — but `loadCandidates` only consults the list when
    // `policy.moduleV2Enabled` is true. With the switch off a bonus run charges
    // the EMI exactly like a regular one, which is the pre-v2 behaviour the
    // kill-switch promises to preserve.
    await generate(p, [borrower.id], { runType: 'BONUS' });

    const row = await rowIn(loanId, p);
    expect(n(row.amount)).toBeCloseTo(600, 2);
    expect(row.outcome).toBe('FULL');
  });

  test('an ON_HOLD loan produces no ledger row at all — not even a zero one', async () => {
    const [p] = reserve();
    const held = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 2,
      firstDue: p,
      status: 'ON_HOLD',
      note: 'held',
    });
    const live = await importLoan({
      employee: borrower,
      principal: 900,
      installments: 3,
      firstDue: p,
      note: 'live alongside a held loan',
    });

    const run = await generate(p, [borrower.id]);

    // The distinction is the point. A skipped instalment is written as a
    // zero-amount SKIPPED row so "why was nothing recovered in June?" is
    // answerable from the ledger. A HELD loan is excluded by
    // `LOAN_RECOVERABLE_STATUSES` at the QUERY level, before the allocator is
    // reached, so there is nothing to explain and no row to explain it with.
    await expect.poll(() => rowsIn(live, p).then((r) => r.length), { timeout: 20_000 }).toBe(1);
    expect(await rowsIn(held, p), 'a held loan was still charged an instalment').toEqual([]);

    const item = await payrollItemFor(adminApi, run.id, borrower.id);
    expect(n(item?.advanceLoanDeduction), 'the held loan reached the payslip').toBeCloseTo(300, 2);
  });

  test('a loan whose live schedule is empty still recovers, one instalment at a time', async () => {
    const [p] = reserve();
    // Every schedule row imported as PAID, but only part of the principal
    // actually repaid — which is the shape of a pre-v2 row: a balance with no
    // live plan behind it. `loadCandidates` tells that apart from "a plan exists
    // but nothing is due yet" and falls through to the legacy bridge, which for
    // a LOAN takes min(installmentAmount, outstanding).
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 2,
      installmentsPaid: 2,
      amountRepaid: 400,
      firstDue: periodAt(PERIOD_BASE - 24),
      note: 'legacy bridge — loan',
    });

    const plan = await scheduleOf(adminApi, loanId);
    expect(
      plan.filter((r) => ['SCHEDULED', 'PARTIAL', 'DEFERRED'].includes(r.status)),
      'the fixture still has a collectable schedule row, so the bridge is not what is being tested',
    ).toEqual([]);

    await generate(p, [borrower.id]);

    const row = await rowIn(loanId, p);
    // levelEmi for 1200 over 2 = 600, and 800 is still owed, so the instalment
    // is the cap rather than the balance.
    expect(n(row.amount)).toBeCloseTo(600, 2);
    // No schedule row to settle: the bridge produces an unlinked ledger row.
    expect(row.scheduleId, 'the bridge invented a schedule link').toBeNull();
    expect(row.outcome).toBe('FULL');
  });

  test('an ADVANCE with no live schedule takes its whole remaining balance', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      type: 'ADVANCE',
      principal: 1000,
      installmentsPaid: 1,
      amountRepaid: 300,
      firstDue: periodAt(PERIOD_BASE - 24),
      note: 'legacy bridge — advance',
    });

    await generate(p, [borrower.id]);

    // The asymmetry is deliberate and is the v1 rule reproduced exactly: an
    // advance is employer cash already out of the door and comes back whole,
    // while a loan comes back an instalment at a time.
    const row = await rowIn(loanId, p);
    expect(n(row.amount)).toBeCloseTo(700, 2);
    expect(row.scheduleId).toBeNull();
  });

  test('a missed cycle sweeps forward: the next run collects both instalments', async () => {
    const [skipped, caught] = reserve(2);
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: skipped,
      note: 'arrears sweep',
    });

    // The first cycle is never run at all — an admin who processed payroll late,
    // which is the ordinary way arrears happen. `loadCandidates` selects
    // `dueCycleKey <= cycleKey`, so the SECOND run picks up both.
    const run = await generate(caught, [borrower.id]);

    const collected = await rowsIn(loanId, caught);
    expect(collected.length, 'the missed instalment was not swept forward').toBe(2);
    expect(collected.map((r) => n(r.amount)).reduce((a, b) => a + b, 0)).toBeCloseTo(600, 2);
    // Both rows are stamped with the cycle they were RECOVERED in, not the one
    // they were due in — the schedule link is what carries the due cycle.
    expect(new Set(collected.map((r) => r.scheduleId)).size).toBe(2);

    // And it reaches the PAYSLIP, which is the half that matters to the
    // employee: one month's pay carries 2 x EMI.
    //
    // With the v2 module OFF — the shipped state this describe runs in — there
    // is no affordability layer on that sweep at all: no minimum-take-home
    // floor, no percentage-of-net cap, no shortfall policy. A single missed
    // cycle therefore doubles the deduction unconditionally, however little is
    // left. The caps in 'affordability once the v2 module is on' are what bound
    // it, and they only exist behind `loan_module_v2_enabled`.
    const item = await payrollItemFor(adminApi, run.id, borrower.id);
    expect(
      n(item?.advanceLoanDeduction),
      'the swept arrear never reached the payslip',
    ).toBeCloseTo(600, 2);
  });

  test('a second run cannot take a second instalment while the first still holds it', async () => {
    const [first, second] = reserve(2);
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: first,
      note: 'in-flight guard',
    });

    const runA = await generate(first, [borrower.id]);
    const claimed = await rowIn(loanId, first);
    expect(claimed.status).toBe('PENDING');

    // Same branch and period twice is refused outright by
    // uniq_payroll_period_branch_batch_version — the friendly half of the same
    // rule, and worth pinning because the in-flight guard below would never be
    // reached if this stopped being a conflict.
    await expect(
      runPayroll(adminApi, {
        month: first.month,
        year: first.year,
        branchId,
        employeeIds: [carrier.id, twin.id, borrower.id],
      }),
    ).rejects.toThrow(/already exists/i);

    // The real guard: `deductions: { none: { status: 'PENDING' } }` keeps the
    // loan out of the NEXT period's run entirely while the draft still holds it,
    // so an unlocked run cannot be double-charged by a later one.
    await generate(second, [borrower.id]);
    expect(
      await rowsIn(loanId, second),
      'the loan was charged again while an unlocked run still held an instalment',
    ).toEqual([]);

    // And the guard clears the moment the claim does: delete the draft and the
    // instalment is released.
    await deletePayroll(adminApi, runA.id);
    expect(await rowsIn(loanId, first)).toEqual([]);
  });

  test('the payslip figure and the ledger rows that were actually inserted agree', async () => {
    const [p] = reserve();
    const a = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'reconciliation A',
    });
    const b = await importLoan({
      employee: borrower,
      type: 'ADVANCE',
      principal: 500,
      firstDue: p,
      note: 'reconciliation B',
    });

    const run = await generate(p, [borrower.id]);
    const item = await payrollItemFor(adminApi, run.id, borrower.id);
    expect(item, 'the borrower was not in the run').toBeTruthy();

    const ledger = [...(await rowsIn(a, p)), ...(await rowsIn(b, p))];
    const inserted = round2(ledger.reduce((s, r) => s + n(r.amount), 0));

    // `create()` restates the item from the ledger after writing it, precisely
    // so a row a concurrent run had already claimed cannot leave the employee
    // short by money that has no ledger entry behind it. Withheld-but-not-
    // credited is the worst available outcome, so this is the invariant.
    expect(n(item!.advanceLoanDeduction)).toBeCloseTo(inserted, 2);
    expect(inserted).toBeCloseTo(800, 2);

    // And the payslip adds up: the twin is the same employee minus the debt, so
    // its net IS this employee's net before recovery.
    expect(n(item!.netSalary) + n(item!.advanceLoanDeduction)).toBeCloseTo(
      await netPreRecovery(run.id),
      2,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Locking — the only place money actually moves
// ───────────────────────────────────────────────────────────────────────────

/**
 * Generation reserves; LOCK pays.
 *
 * Everything above wrote PENDING rows and reduced a net figure. Nothing moved a
 * loan balance, because `applyLock` is the single path that does — a fact worth
 * its own describe, since the module once had TWO paths and only one of them
 * flipped the ledger, so the primary one deducted the EMI from the payslip and
 * never credited the loan.
 */
test.describe('locking a run is what actually repays the loan', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'locking a payroll is an administrative flow');
  });

  test('REGRESSION: amountRepaid moves by PRINCIPAL, never by the cash deducted', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // The ONLY case in this describe that needs a flag, and it needs one for a
    // fixture reason rather than a behavioural one: the importer now REFUSES an
    // interest-bearing row while `loan_interest_enabled` is off (it used to
    // accept it and build the schedule with the interest anyway), and an
    // interest-free loan cannot tell cash apart from principal. The rule under
    // test — lock credits the PRINCIPAL component — is the same either way.
    test.skip(
      !flagFlipAllowed(),
      'the fixture needs an interest-bearing loan, and the importer refuses one unless ' +
        'loan_interest_enabled is on; run with E2E_ALLOW_FLAG_FLIP=1 against its own database',
    );

    const [p] = reserve();
    // FLAT interest, so cash and principal genuinely differ. With
    // interestMethod NONE they are equal and the regression is invisible.
    //
    // The flip wraps the IMPORT alone, which is the only call that consults the
    // switch — `applyLock` works off the schedule rows this creates, and
    // `LoanScheduleService.generate`/`regenerate` (the two other readers) are
    // not on the payroll path. Narrowest possible window on an environment-wide
    // setting.
    const loanId = await withSettings(adminApi, { loan_interest_enabled: 'true' }, () =>
      importLoan({
        employee: borrower,
        principal: 1200,
        installments: 2,
        firstDue: p,
        interestMethod: 'FLAT',
        interestRate: 12,
        note: 'principal-only counter',
      }),
    );

    const plan = await scheduleOf(adminApi, loanId);
    const first = plan.find((r) => r.installmentNo === 1)!;
    expect(first.interestComponent, 'the fixture carries no interest, so cash equals principal').toBeGreaterThan(0);

    await generateAndLock(p, [borrower.id]);

    const row = await rowIn(loanId, p);
    expect(row.status, 'locking did not flip the ledger row').toBe('PAID');

    const loan = await loanOf(adminApi, loanId);
    // The bug this names: crediting `amountRepaid` with the CASH would repay the
    // loan faster than the employee actually paid it, and auto-close it early.
    expect(n(loan.amountRepaid)).toBeCloseTo(n(row.principalComponent), 2);
    expect(n(loan.amountRepaid), 'the cash total was credited as principal').toBeLessThan(n(row.amount));
    // Interest and fees have counters of their own, so neither leaks into the
    // balance that decides when the loan is finished.
    expect(n(loan.interestPaid)).toBeCloseTo(n(row.interestComponent), 2);
    // No import row can carry a processing fee, so this is asserted at zero
    // rather than left unstated — a fee that started appearing here would be a
    // real change and should fail.
    expect(n(loan.feesPaid)).toBe(0);
    expect(n(row.feeComponent)).toBe(0);

    // The DB CHECK behind the split, asserted from outside it.
    expect(
      round2(n(row.principalComponent) + n(row.interestComponent) + n(row.feeComponent)),
    ).toBeCloseTo(n(row.amount), 2);
  });

  test('the schedule row is projected from the ledger, and an EMI_RECOVERY mirrors it', async () => {
    // Repeated from the case above, which is skipped without E2E_ALLOW_FLAG_FLIP
    // — this is the first case in the describe that always runs, and a failed
    // calibration has to say so once rather than surfacing as a wrong number.
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'schedule projection',
    });

    const before = await scheduleOf(adminApi, loanId);
    expect(before.find((r) => r.installmentNo === 1)!.status).toBe('SCHEDULED');

    await generateAndLock(p, [borrower.id]);

    // Payroll generation never writes to the plan; lock is the only place the
    // schedule learns money moved, which is what makes deleting a draft a no-op
    // for the plan. PAID rather than PARTIAL because
    // `paidAmount >= emiAmount - 0.005`.
    await expect
      .poll(async () => (await scheduleOf(adminApi, loanId)).find((r) => r.installmentNo === 1)?.status, {
        timeout: 20_000,
      })
      .toBe('PAID');
    const after = await scheduleOf(adminApi, loanId);
    expect(after.find((r) => r.installmentNo === 1)!.paidAmount).toBeCloseTo(300, 2);
    expect(after.find((r) => r.installmentNo === 2)!.status).toBe('SCHEDULED');

    // The statement is where an employee and the accounting journal read one
    // continuous stream, so the recovery has to appear as a transaction too.
    const statement = await adminApi.get<StatementLoan[]>(
      `/advance-loans/reports/employee/${borrower.id}/statement`,
    );
    const mine = (Array.isArray(statement) ? statement : []).find((l) => l.id === loanId);
    const recoveries = (mine?.transactions ?? []).filter((t) => t.type === 'EMI_RECOVERY');
    expect(recoveries.length, 'the recovery never reached the money ledger').toBe(1);
    expect(n(recoveries[0].amount)).toBeCloseTo(300, 2);
    expect(recoveries[0].narration ?? '').toContain('Recovered in payroll');
    // The row's `deductionId` back-reference is real but is not selected by the
    // statement projection, so it is not assertable from here.
  });

  test('the final instalment completes the loan inside the same transaction', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 300,
      installments: 1,
      firstDue: p,
      note: 'auto-complete',
    });

    await generateAndLock(p, [borrower.id]);

    // Auto-closure is a CONSEQUENCE of the balance moving and is committed with
    // it. If it were a separate step, a crash in between would leave a fully
    // repaid loan APPROVED with amountRepaid == amount, and the next run would
    // plan a zero-due instalment against it forever.
    await expect
      .poll(async () => (await loanOf(adminApi, loanId)).status, { timeout: 20_000 })
      .toBe('COMPLETED');
    const loan = await loanOf(adminApi, loanId);
    expect(n(loan.amountRepaid)).toBeCloseTo(300, 2);
    expect(loan.completedAt, 'a completed loan carries no completion timestamp').toBeTruthy();
  });

  test('a loan that still owes money is not completed', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'still owing',
    });

    await generateAndLock(p, [borrower.id]);

    const loan = await loanOf(adminApi, loanId);
    expect(n(loan.amountRepaid)).toBeCloseTo(300, 2);
    // The other half of the sweep, without which "auto-close" would be
    // indistinguishable from "close everything the run touched".
    expect(loan.status, 'a loan with a balance was closed by one instalment').not.toBe('COMPLETED');
  });

  test('the loan screen shows the money moved, the row settled and the ledger filled', async ({
    page,
    problems,
  }) => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'browser proof',
    });

    await selectBranch(page, branchId);
    const detail = new LoanLifecyclePage(page);
    await detail.open(loanId);
    // Read BEFORE the run, so the assertions after it are about movement rather
    // than about a number that happened to be right.
    await expect.poll(() => detail.summary('repaid'), { timeout: 20_000 }).toBe(0);
    expect(await detail.ledgerIsEmpty(), 'the ledger had rows before payroll ran').toBe(true);

    await generateAndLock(p, [borrower.id]);

    await detail.open(loanId);
    // Every number off `data-value`, never off rendered currency: formatCurrency
    // inserts a locale separator and a symbol, so parsing its output would
    // assert `Intl` rather than the loan.
    await expect.poll(() => detail.summary('repaid'), { timeout: 20_000 }).toBe(300);
    expect(await detail.summary('outstanding')).toBe(900);
    expect(await detail.scheduleRowStatus(1)).toBe('PAID');
    expect(await detail.scheduleRowStatus(2)).toBe('SCHEDULED');
    // "Nothing recovered yet" is a whole screen state, and it is the one a user
    // sees when the ledger silently failed to write.
    expect(await detail.ledgerIsEmpty(), 'the recovery never reached the screen').toBe(false);

    settle(problems, 'the loan detail screen after a locked payroll run');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Taking it back: delete, unlock, revise
// ───────────────────────────────────────────────────────────────────────────

/**
 * The three ways a run stops counting, and what each does to the money.
 *
 * They are genuinely different: DELETE re-releases an instalment that was only
 * ever reserved, UNLOCK reverses one that was actually paid without deleting the
 * history, and a REVISION copies the payslip WITHOUT copying the ledger — which
 * is the only thing standing between "correct a locked run" and "charge the
 * employee twice".
 */
test.describe('a run that is deleted, reversed or revised', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'deleting and reversing payroll is an administrative flow');
  });

  test('deleting a draft re-releases the instalment, and a re-run takes it exactly once', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // ONE cycle, deliberately. An earlier version of this case reserved two
    // consecutive months and re-ran in the SECOND one, which made the re-run
    // sweep instalment #1 (missed, its draft deleted) AND instalment #2 (due
    // that month) — two rows, 600 on the payslip, and a failure that read like
    // a double-deduction when it was the documented arrears sweep
    // (`loan-recovery.service.ts:92-95`). "A re-run takes it exactly once"
    // means the SAME period twice; the delete is what unblocks it, because
    // `PayrollsService.remove` is a hard delete, so
    // `uniq_payroll_period_branch_batch_version` no longer sees the first run.
    // The sweep itself has its own case above.
    const [first] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: first,
      note: 'delete re-releases',
    });
    const held = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 2,
      firstDue: periodAt(PERIOD_BASE + 400),
      note: 'delete — nothing due yet',
    });

    const run = await generate(first, [borrower.id]);
    expect((await rowsIn(loanId, first))[0].status).toBe('PENDING');
    // Nothing is due on the second loan for another thirty years, so it is a
    // candidate with no due row — which the planner records as nothing at all.
    expect(await rowsIn(held, first)).toEqual([]);

    await deletePayroll(adminApi, run.id);

    // PENDING and SKIPPED rows are deleted explicitly (the FK is SetNull, so the
    // delete no longer cascades them away), which is what keeps "deleting a
    // draft re-releases its instalments" true.
    expect(await rowsIn(loanId, first), 'the reservation outlived the run that made it').toEqual([]);

    const rerun = await generate(first, [borrower.id]);
    const row = await rowIn(loanId, first);
    expect(n(row.amount)).toBeCloseTo(300, 2);
    expect(row.status).toBe('PENDING');
    // Exactly once, and against the same instalment: the re-run re-reserves the
    // row the delete released rather than reserving a second one.
    const live = (await rows(loanId)).filter((r) => r.status !== 'SKIPPED');
    expect(
      live.length,
      `the instalment was reserved more than once: ${live.map(describeRow).join(' ')}`,
    ).toBe(1);
    // Bound to a schedule row, which is what puts it under
    // `advance_loan_deductions_schedule_live_uq` — the per-`scheduleId` partial
    // index that makes a second live reservation of one instalment impossible.
    expect(row.scheduleId, 'the re-reserved row is not linked to an instalment').toBeTruthy();

    const item = await payrollItemFor(adminApi, rerun.id, borrower.id);
    expect(n(item?.advanceLoanDeduction)).toBeCloseTo(300, 2);
  });

  test('unlocking reverses the recovery by appending, never by editing history', async () => {
    const [p] = reserve();
    // Interest-free, unlike the case above: the importer refuses an
    // interest-bearing row while `loan_interest_enabled` is off, and interest is
    // incidental here — the claim is that the reversal APPENDS rather than
    // rewrites, which is a statement about rows and not about the split. Only
    // the `interestPaid` line below loses its bite, and the REGRESSION case owns
    // the split. Flipping the switch for this would take the whole reversal
    // journey out of a default run for a decoration.
    const loanId = await importLoan({
      employee: borrower,
      principal: 600,
      installments: 2,
      firstDue: p,
      note: 'unlock reversal',
    });

    const runId = await generateAndLock(p, [borrower.id]);
    const paid = await rowIn(loanId, p);
    expect(paid.status).toBe('PAID');
    const afterLock = await loanOf(adminApi, loanId);

    await unlockPayroll(adminApi, runId, `${MARK} the overtime figures were wrong`);

    await expect
      .poll(async () => (await rowIn(loanId, p)).status, { timeout: 20_000 })
      .toBe('REVERSED');
    const reversed = await rowIn(loanId, p);
    // The original row is RESTATED, not rewritten: the amounts it recorded are
    // still the amounts it recorded, which is what makes the audit trail worth
    // keeping.
    expect(n(reversed.amount)).toBeCloseTo(n(paid.amount), 2);
    expect(n(reversed.principalComponent)).toBeCloseTo(n(paid.principalComponent), 2);
    expect(reversed.reversedAt, 'the reversal left no timestamp on the row it restated').toBeTruthy();

    const loan = await loanOf(adminApi, loanId);
    expect(n(loan.amountRepaid)).toBeCloseTo(n(afterLock.amountRepaid) - n(paid.principalComponent), 2);
    expect(n(loan.interestPaid)).toBeCloseTo(n(afterLock.interestPaid) - n(paid.interestComponent), 2);

    // The plan is restored too — SCHEDULED rather than PARTIAL, because nothing
    // is left against it — and the settlement stamp is cleared.
    const plan = await scheduleOf(adminApi, loanId);
    expect(plan.find((r) => r.installmentNo === 1)!.status).toBe('SCHEDULED');
    expect(plan.find((r) => r.installmentNo === 1)!.paidAmount).toBe(0);

    // And the reversal is its own money event rather than the deletion of one.
    const statement = await adminApi.get<StatementLoan[]>(
      `/advance-loans/reports/employee/${borrower.id}/statement`,
    );
    const txns = (Array.isArray(statement) ? statement : []).find((l) => l.id === loanId)?.transactions ?? [];
    expect(txns.filter((t) => t.type === 'EMI_RECOVERY').length, 'the original recovery was deleted').toBe(1);
    const reversals = txns.filter((t) => t.type === 'REVERSAL');
    expect(reversals.length).toBe(1);
    expect(reversals[0].narration ?? '').toContain(MARK);
  });

  test('a loan the run auto-closed is reopened when the balance is genuinely owed again', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 300,
      installments: 1,
      firstDue: p,
      note: 'reopen on unlock',
    });

    const runId = await generateAndLock(p, [borrower.id]);
    await expect
      .poll(async () => (await loanOf(adminApi, loanId)).status, { timeout: 20_000 })
      .toBe('COMPLETED');

    await unlockPayroll(adminApi, runId, `${MARK} the run was locked against the wrong period`);

    // Reopened, not merely un-completed: the money is owed again, so the loan
    // has to be collectable again. Anything else strands a live debt in a
    // terminal status where no future run will ever look at it.
    await expect
      .poll(async () => (await loanOf(adminApi, loanId)).status, { timeout: 20_000 })
      .toBe('ACTIVE');
    const loan = await loanOf(adminApi, loanId);
    expect(n(loan.amountRepaid)).toBe(0);
    expect(loan.completedAt, 'the completion stamp survived the reversal').toBeFalsy();
  });

  test('unlocking is refused when a later run has already recovered against the loan', async () => {
    const [first, second] = reserve(2);
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: first,
      note: 'out-of-order reversal',
    });

    const runA = await generateAndLock(first, [borrower.id]);
    await generateAndLock(second, [borrower.id]);
    expect((await rowsIn(loanId, second))[0].status).toBe('PAID');

    // Reversing out of order would corrupt the carry-forward state of every
    // later cycle, so the most recent recovery must come off first. The refusal
    // names the run that is in the way, which is the only thing the operator can
    // act on.
    await expect(
      adminApi.post(`/payrolls/${runA}/unlock`, { reason: `${MARK} reversing the wrong run first` }),
    ).rejects.toThrow(/later payroll run/i);

    const loan = await loanOf(adminApi, loanId);
    expect(n(loan.amountRepaid), 'the refused reversal moved money anyway').toBeCloseTo(600, 2);
  });

  test('unlocking is ADMIN-only — an HR_MANAGER who can lock cannot reverse', async () => {
    const [p] = reserve();
    await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'unlock role gate',
    });

    const runId = await generateAndLock(p, [borrower.id]);

    // The asymmetry is the rule: `POST /:id/lock` admits ADMIN and HR_MANAGER,
    // `POST /:id/unlock` admits ADMIN alone. Reversal restates payslips that
    // have already been published, so it is a narrower door than the one that
    // published them.
    await expect(
      hrApi.post(`/payrolls/${runId}/unlock`, { reason: `${MARK} attempting a reversal as HR` }),
    ).rejects.toThrow(/403/);

    const run = await adminApi.get<{ status: string }>(`/payrolls/${runId}`);
    expect(run.status, 'the refused unlock reversed the run anyway').toBe('LOCKED');
  });

  test('REGRESSION: locking a revision does not move the money a second time', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'revision double-charge',
    });

    const original = await generateAndLock(p, [borrower.id]);
    const afterFirst = await loanOf(adminApi, loanId);
    expect(n(afterFirst.amountRepaid)).toBeCloseTo(300, 2);

    const revision = await adminApi.post<{ id: string }>(`/payrolls/${original}/create-revision`, {
      reason: `${MARK} correcting an overtime figure`,
    });
    await approveRun(revision.id);
    await lockPayroll(adminApi, revision.id);

    // `createRevision` copies the payroll ITEMS — including the
    // `advanceLoanDeduction` figure, so the corrected payslip still reads
    // correctly — but creates NO ledger rows. `applyLock` works from the ledger,
    // so there is nothing for it to flip and the balance cannot move twice.
    const after = await loanOf(adminApi, loanId);
    expect(n(after.amountRepaid), 'the revision charged the instalment again').toBeCloseTo(300, 2);

    const item = await payrollItemFor(adminApi, revision.id, borrower.id);
    expect(n(item?.advanceLoanDeduction), 'the revision lost the deduction from the payslip').toBeCloseTo(300, 2);
    expect(
      (await rowsIn(loanId, p)).length,
      'the revision created a second ledger row for the same instalment',
    ).toBe(1);

    // Teardown order matters here and the helper cannot know it: the revision is
    // the LATER locked run and has to be reversed before the original.
    await unlockPayroll(adminApi, revision.id, `${MARK} teardown of the revision`).catch(() => undefined);
    await deletePayroll(adminApi, revision.id).catch(() => undefined);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Affordability, with the v2 module switched on
// ───────────────────────────────────────────────────────────────────────────

/**
 * The whole point of v2: an instalment is taken only out of money the employee
 * can actually spare.
 *
 * Every case here computes its expected figure IN THE SPEC, from the formula and
 * from the net the twin measured — not from a constant, and not from what the
 * server said. A test that read the server's own answer back would pass whatever
 * the allocator did.
 */
test.describe('affordability once the v2 module is on', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll generation is an administrative flow');
    test.skip(
      !flagFlipAllowed(),
      'flips loan_module_v2_enabled, which is environment-wide; run with E2E_ALLOW_FLAG_FLIP=1 against its own database',
    );
  });

  /** The formula under test, written out once so each case reads as its inputs. */
  const poolFor = (
    netPre: number,
    o: { minAmount?: number; minPercent?: number; maxPercent?: number },
  ): number => {
    const protectedNet = Math.max(o.minAmount ?? 0, (netPre * (o.minPercent ?? 0)) / 100);
    const capByPercent = (netPre * (o.maxPercent ?? 50)) / 100;
    return round2(Math.max(0, Math.min(netPre - protectedNet, capByPercent)));
  };

  test('PARTIAL part-pays what it can afford and carries the rest forward', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'shortfall PARTIAL',
    });

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_shortfall_policy: 'PARTIAL' },
      async () => {
        const run = await generate(p, [borrower.id]);
        const netPre = await netPreRecovery(run.id);
        // Nothing else is set, so the only constraint is the default 50 % cap.
        const pool = poolFor(netPre, {});

        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBeCloseTo(pool, 2);
        expect(row.outcome).toBe('PARTIAL');
        expect(row.reason).toBe('INSUFFICIENT_NET');
        // The shortfall is recorded rather than forgotten, which is what makes
        // the remainder collectable next cycle.
        expect(n(row.shortfallAmount)).toBeCloseTo(round2(emi - pool), 2);
        expect(n(row.plannedAmount)).toBeCloseTo(emi, 2);

        // The same setup with the switch off took the whole EMI — see the first
        // case in this file. This is the only line of code that changes it.
        expect(pool).toBeLessThan(emi);

        const item = await payrollItemFor(adminApi, run.id, borrower.id);
        expect(n(item?.netSalary)).toBeCloseTo(round2(netPre - pool), 2);
        expect(n(item?.netSalary), 'the protected take-home was breached').toBeGreaterThan(0);
      },
    );
  });

  test('SKIP recovers nothing at all that cycle rather than part of it', async () => {
    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'shortfall SKIP',
    });

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_shortfall_policy: 'SKIP' },
      async () => {
        const run = await generate(p, [borrower.id]);

        // ALL_OR_NOTHING inside the allocator: a row it cannot fully fund is
        // passed over. The row still EXISTS, at zero, because "nothing was
        // recovered in June" has to be answerable from the ledger alone.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        expect(row.outcome).toBe('SKIP');
        expect(row.reason).toBe('INSUFFICIENT_NET');
        expect(row.status, 'a zero-amount row was left PENDING and will block later runs').toBe('SKIPPED');
        expect(n(row.shortfallAmount)).toBeCloseTo(emi, 2);

        const item = await payrollItemFor(adminApi, run.id, borrower.id);
        expect(n(item?.advanceLoanDeduction)).toBe(0);
        expect(n(item?.netSalary)).toBeCloseTo(await netPreRecovery(run.id), 2);
      },
    );
  });

  test('DEFER declines the partial too, and says so in the outcome', async () => {
    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'shortfall DEFER',
    });

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_shortfall_policy: 'DEFER' },
      async () => {
        await generate(p, [borrower.id]);

        // The allocator declines a partial payment for DEFER exactly as it does
        // for SKIP — the difference is what the SCHEDULE does afterwards, and it
        // is the OUTCOME that records which of the two a reader is looking at.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        expect(row.outcome).toBe('DEFER');
        expect(row.reason).toBe('INSUFFICIENT_NET');
      },
    );
  });

  test('the minimum take-home PERCENTAGE decides the pool', async () => {
    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'min net percent',
    });

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'PARTIAL',
        loan_min_net_pay_percent: '80',
        // Lifted out of the way so the FLOOR is the only binding constraint and
        // a failure here cannot be the cap in disguise.
        loan_max_total_deduction_percent_of_net: '100',
        loan_min_net_pay_amount: '0',
      },
      async () => {
        const run = await generate(p, [borrower.id]);
        const netPre = await netPreRecovery(run.id);
        const expected = poolFor(netPre, { minPercent: 80, maxPercent: 100 });

        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBeCloseTo(expected, 2);
        // Stated the second way round as well, because "20 % of net" is the
        // sentence a policy owner would recognise.
        expect(n(row.amount)).toBeCloseTo(round2(netPre * 0.2), 2);

        const item = await payrollItemFor(adminApi, run.id, borrower.id);
        expect(n(item?.netSalary)).toBeCloseTo(round2(netPre * 0.8), 2);
      },
    );
  });

  test('the minimum take-home AMOUNT decides it when it is the higher floor', async () => {
    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'min net amount',
    });

    // 90 % of the measured net, as an absolute figure. The percentage floor is
    // left at zero so the two cannot be confused: `protectedNet` is the MAXIMUM
    // of the pair, and this proves the absolute half is consulted at all.
    const floor = round2(NET * 0.9);

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'PARTIAL',
        loan_min_net_pay_amount: String(floor),
        loan_min_net_pay_percent: '0',
        loan_max_total_deduction_percent_of_net: '100',
      },
      async () => {
        const run = await generate(p, [borrower.id]);
        const netPre = await netPreRecovery(run.id);
        const expected = poolFor(netPre, { minAmount: floor, maxPercent: 100 });

        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBeCloseTo(expected, 2);
        expect(expected, 'the fixture left nothing to recover, so the case is vacuous').toBeGreaterThan(0);
      },
    );
  });

  test('the total-deduction percentage caps the pool below the floor', async () => {
    const [p] = reserve();
    const emi = round2(NET * 2);
    const loanId = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'max total deduction percent',
    });

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'PARTIAL',
        // The floor would allow the whole net; the cap allows a tenth of it.
        // `pool` is the MINIMUM of the two, so the cap has to win.
        loan_min_net_pay_percent: '0',
        loan_min_net_pay_amount: '0',
        loan_max_total_deduction_percent_of_net: '10',
      },
      async () => {
        const run = await generate(p, [borrower.id]);
        const netPre = await netPreRecovery(run.id);
        const expected = poolFor(netPre, { maxPercent: 10 });

        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBeCloseTo(expected, 2);
        expect(n(row.amount)).toBeCloseTo(round2(netPre * 0.1), 2);
        expect(row.outcome).toBe('PARTIAL');
      },
    );
  });

  test('a pool of nothing recovers nothing, and every line says INSUFFICIENT_NET', async () => {
    const [p] = reserve();
    const a = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'pool exhausted A',
    });
    const b = await importLoan({
      employee: borrower,
      type: 'ADVANCE',
      principal: 500,
      firstDue: p,
      note: 'pool exhausted B',
    });

    // A floor above the whole net: the employee is protected from every
    // deduction, so the pool clamps to zero before allocation is even attempted.
    const floor = round2(NET + 1000);

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'SKIP',
        loan_min_net_pay_amount: String(floor),
      },
      async () => {
        const run = await generate(p, [borrower.id]);

        // BOTH loans get an explanatory zero row — `skipAll` writes one per
        // candidate rather than abandoning the cycle silently.
        for (const loanId of [a, b]) {
          const row = await rowIn(loanId, p);
          expect(n(row.amount)).toBe(0);
          expect(row.reason).toBe('INSUFFICIENT_NET');
          expect(row.outcome).toBe('SKIP');
        }

        const item = await payrollItemFor(adminApi, run.id, borrower.id);
        expect(n(item?.advanceLoanDeduction)).toBe(0);
        // The note is where the employee finds out why their payslip looks
        // different, so an unexplained skip is a support ticket.
        expect(String(item?.notes ?? '')).toContain('protected minimum take-home');
      },
    );
  });

  test('a partial too small to be worth posting is deferred whole', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: borrower,
      principal: round2(NET * 2),
      installments: 1,
      firstDue: p,
      note: 'below the minimum partial',
    });

    // Leaves exactly 0.50 spendable — below the default
    // `loan_min_partial_recovery_amount` of 1. Reached through the FLOOR rather
    // than by writing that key, which `withSetting` refuses because
    // GET /system-settings does not return it and its original value could not
    // be restored.
    const floor = round2(NET - 0.5);

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'PARTIAL',
        loan_min_net_pay_amount: String(floor),
        loan_min_net_pay_percent: '0',
        loan_max_total_deduction_percent_of_net: '100',
      },
      async () => {
        const run = await generate(p, [borrower.id]);
        expect(poolFor(await netPreRecovery(run.id), { minAmount: floor, maxPercent: 100 })).toBeCloseTo(0.5, 2);

        // PARTIAL is the policy and a partial WAS affordable — but posting 0.50
        // against a loan fills the ledger with rows worth less than the audit
        // they generate, so it is declined as a whole.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        expect(row.outcome).toBe('DEFER');
        expect(row.reason).toBe('INSUFFICIENT_NET');
      },
    );
  });

  test('a zero-pay cycle defers rather than skipping, and says ZERO_NET', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: pauper,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'zero net — default policy',
    });

    await withSettings(adminApi, { loan_module_v2_enabled: 'true' }, async () => {
      const run = await generate(p, [pauper.id]);
      const item = await payrollItemFor(adminApi, run.id, pauper.id);
      expect(n(item?.netSalary), 'the fixture is being paid after all').toBe(0);

      // ZERO_NET is a different fact from INSUFFICIENT_NET and gets its own
      // reason: one is "there was money and not enough of it", the other is
      // "there was no pay cycle to deduct from".
      const row = await rowIn(loanId, p);
      expect(n(row.amount)).toBe(0);
      expect(row.reason).toBe('ZERO_NET');
      // `loan_zero_salary_policy` defaults to DEFER: the instalment is owed
      // later rather than written off.
      expect(row.outcome).toBe('DEFER');
      expect(String(item?.notes ?? '')).toContain('net pay for this cycle is zero');
    });
  });

  test('loan_zero_salary_policy = SKIP turns the same cycle into a skip', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: pauper,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'zero net — SKIP',
    });

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_zero_salary_policy: 'SKIP' },
      async () => {
        await generate(p, [pauper.id]);
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        // Same reason, different outcome — which is exactly the distinction the
        // two columns exist to carry.
        expect(row.reason).toBe('ZERO_NET');
        expect(row.outcome).toBe('SKIP');
      },
    );
  });

  test('a BONUS run recovers nothing while a REGULAR one recovers in full', async () => {
    const [bonus, regular] = reserve(2);
    const loanId = await importLoan({
      employee: borrower,
      principal: 1200,
      installments: 4,
      firstDue: bonus,
      note: 'run type gate',
    });

    await withSettings(adminApi, { loan_module_v2_enabled: 'true' }, async () => {
      // `loan_recover_on_run_types` defaults to REGULAR,FINAL_SETTLEMENT.
      // `loadCandidates` returns an EMPTY map for anything else, so a bonus run
      // does not even produce an explanatory row — there is no candidate to
      // explain. That is what stops an out-of-cycle payment charging the EMI a
      // second time in the same month.
      const bonusRun = await generate(bonus, [borrower.id], { runType: 'BONUS' });
      expect(await rowsIn(loanId, bonus), 'a bonus run charged an instalment').toEqual([]);
      const bonusItem = await payrollItemFor(adminApi, bonusRun.id, borrower.id);
      expect(n(bonusItem?.advanceLoanDeduction)).toBe(0);

      // The control: the same loan, the same settings, the very next cycle, on a
      // run type that IS listed.
      //
      // `bonus` and `regular` are CONSECUTIVE months and instalment #1 was left
      // uncollected by the bonus run, so the arrears sweep
      // (`loan-recovery.service.ts:182`) hands this run BOTH #1 and #2 — which
      // is itself the proof the bonus run deferred the instalment rather than
      // quietly taking it. Asserting a single 300 row here would fail on two
      // legitimate rows, so the expectation is the pair.
      await generate(regular, [borrower.id], { runType: 'REGULAR' });
      const collected = await rowsIn(loanId, regular);
      expect(
        collected.length,
        `the bonus cycle's instalment was not swept into the regular run: ` +
          collected.map(describeRow).join(' '),
      ).toBe(2);
      expect(collected.map((r) => n(r.amount)).reduce((a, b) => a + b, 0)).toBeCloseTo(600, 2);
      expect(collected.every((r) => r.outcome === 'FULL')).toBe(true);
    });
  });

  test('a FINAL_SETTLEMENT run lifts both the take-home floor and the percentage cap', async () => {
    const [settlement, ordinary] = reserve(2);
    const emi = round2(NET * 0.6);
    const settled = await importLoan({
      employee: borrower,
      principal: emi,
      installments: 1,
      firstDue: settlement,
      note: 'final settlement',
    });
    const control = await importLoan({
      employee: leaver,
      principal: emi,
      installments: 1,
      firstDue: ordinary,
      note: 'final settlement control',
    });

    // A floor above the whole net AND a cap of one percent. Under either one a
    // regular run recovers nothing at all.
    const settings = {
      loan_module_v2_enabled: 'true',
      loan_shortfall_policy: 'PARTIAL',
      loan_min_net_pay_amount: String(round2(NET + 1000)),
      loan_max_total_deduction_percent_of_net: '1',
    };

    await withSettings(adminApi, settings, async () => {
      // `loan_final_settlement_ignores_min_net` defaults to true and is asserted
      // at its default rather than written: GET /system-settings does not return
      // it, so `withSetting` refuses to change something it could not restore.
      await generate(settlement, [borrower.id], { runType: 'FINAL_SETTLEMENT' });
      const row = await rowIn(settled, settlement);
      expect(n(row.amount), 'a final settlement was still capped').toBeCloseTo(emi, 2);
      expect(row.outcome).toBe('FULL');

      // The control proves the settings were biting: the same figures on a
      // REGULAR run recover nothing.
      await generate(ordinary, [leaver.id], { runType: 'REGULAR' });
      const blocked = await rowIn(control, ordinary);
      expect(n(blocked.amount)).toBe(0);
      expect(blocked.reason).toBe('INSUFFICIENT_NET');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Unpaid leave
// ───────────────────────────────────────────────────────────────────────────

/**
 * What a month off without pay does to an instalment.
 *
 * Three answers, all legitimate and all configured rather than coded: CONTINUE
 * takes it anyway, PAUSE forgoes the cycle, EXTEND defers it and lengthens the
 * plan.
 *
 * The subject is given real PRESENT days for the cycle, and this is load-bearing.
 * An employee with NO attendance rows is normally treated as fully present — but
 * once an approved leave overlaps the cycle, payroll computes payable days for
 * real, finds no present ones, and pays nothing. The allocator then answers
 * `ZERO_NET` before it ever consults the leave policy, so CONTINUE and PAUSE
 * become indistinguishable: both recover nothing, and the test that meant to
 * prove "CONTINUE collects anyway" would be proving "there was nothing to
 * collect from". PAUSE and EXTEND return BEFORE the zero-net branch, which is
 * why they passed while CONTINUE did not — the two failures look identical from
 * the outside and only one of them was real.
 */
test.describe('unpaid leave decides whether the instalment is taken at all', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll generation is an administrative flow');
    test.skip(
      !flagFlipAllowed(),
      'the leave policies are only consulted when loan_module_v2_enabled is on; run with E2E_ALLOW_FLAG_FLIP=1',
    );
  });

  /**
   * An APPROVED unpaid leave covering `days` calendar days of the cycle.
   *
   * `UNPAID` resolves to the seeded `Unpaid Leave` library row, which is
   * `isPaid: false`, `affectsBalance: false` and needs no notice — so no balance
   * has to be granted first and no notice window has to be waited out. Payroll
   * counts CALENDAR days of overlap, not working days, which is what makes the
   * `loan_unpaid_leave_min_days` boundary assertable at all.
   */
  /**
   * PRESENT days across the cycle, AFTER the leave window.
   *
   * Days 10-24 are used: the leave this file approves runs from the 5th, so
   * these never overlap it and the two facts stay independent. Fifteen days is
   * comfortably more than enough net to afford a 300 instalment out of a 40,000
   * salary, and small enough not to make the setup the slowest thing here.
   */
  async function markPresent(employeeId: string, p: Period): Promise<void> {
    const month = String(p.month).padStart(2, '0');
    for (let day = 10; day <= 24; day += 1) {
      await adminApi
        .post('/attendances/manual', {
          employeeId,
          date: `${p.year}-${month}-${String(day).padStart(2, '0')}`,
          checkIn: '09:00',
          checkOut: '17:00',
          status: 'PRESENT',
          notes: `${MARK} present day for the unpaid-leave cycle`,
        })
        .catch(() => undefined);
    }
  }

  async function approveUnpaidLeave(employeeId: string, p: Period, days: number): Promise<void> {
    const start = `${p.year}-${String(p.month).padStart(2, '0')}-05`;
    const end = `${p.year}-${String(p.month).padStart(2, '0')}-${String(4 + days).padStart(2, '0')}`;
    const created = await adminApi.post<{ id: string }>('/leave-requests', {
      employeeId,
      leaveType: 'UNPAID',
      startDate: start,
      endDate: end,
      reason: `${MARK} unpaid leave for the recovery journey`,
    });
    await adminApi.post(`/leave-requests/${created.id}/approve`, { comment: `${MARK} approved` });
  }

  test('CONTINUE keeps deducting through the unpaid month', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const [p] = reserve();
    const loanId = await importLoan({
      employee: leaver,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'leave CONTINUE',
    });
    await markPresent(leaver.id, p);
    await approveUnpaidLeave(leaver.id, p, 5);

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_unpaid_leave_policy: 'CONTINUE',
        // The subject here is the LEAVE policy, so the affordability floor is
        // opened out for the duration. Five unpaid days cut the net enough that
        // the default floor would refuse the instalment on its own — and a
        // zero recovery for the wrong reason would look exactly like CONTINUE
        // failing. The floor has its own cases; this one must not depend on it.
        loan_min_net_pay_amount: '0',
        loan_min_net_pay_percent: '0',
        loan_max_total_deduction_percent_of_net: '100',
      },
      async () => {
        await generate(p, [leaver.id]);

        // CONTINUE is not "ignore the leave" — the days are still counted and
        // the policy is still resolved. It is a decision to collect anyway, and
        // it lands as an ordinary affordable recovery.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBeCloseTo(300, 2);
        expect(row.outcome).toBe('FULL');
        expect(row.reason).toBe('AFFORDABLE');
      },
    );
  });

  test('PAUSE forgoes the cycle and records UNPAID_LEAVE as the reason', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: leaver,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'leave PAUSE',
    });
    await markPresent(leaver.id, p);
    await approveUnpaidLeave(leaver.id, p, 5);

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_unpaid_leave_policy: 'PAUSE' },
      async () => {
        const run = await generate(p, [leaver.id]);

        // The reason is the whole value of the row. Without it, a paused cycle
        // and a cycle the employee could not afford look identical to everyone
        // who has to explain the payslip.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        expect(row.outcome).toBe('SKIP');
        expect(row.reason).toBe('UNPAID_LEAVE');
        expect(n(row.shortfallAmount)).toBeCloseTo(300, 2);

        const item = await payrollItemFor(adminApi, run.id, leaver.id);
        expect(String(item?.notes ?? '')).toContain('unpaid leave day');
      },
    );
  });

  test('EXTEND defers the instalment instead of skipping it', async () => {
    const [p] = reserve();
    const loanId = await importLoan({
      employee: leaver,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'leave EXTEND',
    });
    await markPresent(leaver.id, p);
    await approveUnpaidLeave(leaver.id, p, 5);

    await withSettings(
      adminApi,
      { loan_module_v2_enabled: 'true', loan_unpaid_leave_policy: 'EXTEND' },
      async () => {
        const run = await generate(p, [leaver.id]);

        // Same money — none — and a different promise about it: the tenure
        // stretches rather than the instalment being written off the cycle.
        const row = await rowIn(loanId, p);
        expect(n(row.amount)).toBe(0);
        expect(row.outcome).toBe('DEFER');
        expect(row.reason).toBe('UNPAID_LEAVE');

        const item = await payrollItemFor(adminApi, run.id, leaver.id);
        expect(String(item?.notes ?? '')).toContain('schedule extended');
      },
    );
  });

  test('the minimum-days threshold is a boundary, not a suggestion', async () => {
    const [under, over] = reserve(2);
    const shortMonth = await importLoan({
      employee: leaver,
      principal: 1200,
      installments: 4,
      firstDue: under,
      note: 'leave min days — under',
    });
    const longMonth = await importLoan({
      employee: juggler,
      principal: 1200,
      installments: 4,
      firstDue: over,
      note: 'leave min days — over',
    });
    // Both subjects are paid for their cycle before any leave is approved —
    // see `markPresent`. The UNDER case is the one that needs it: it must
    // recover in full, and an unpaid subject would answer ZERO_NET instead,
    // which looks exactly like the threshold having triggered.
    await markPresent(leaver.id, under);
    await markPresent(juggler.id, over);

    // Two days is one under a threshold of three; three is the threshold itself,
    // and the comparison is `>=`, so it is the first value that pauses.
    await approveUnpaidLeave(leaver.id, under, 2);
    await approveUnpaidLeave(juggler.id, over, 3);

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_unpaid_leave_policy: 'PAUSE',
        loan_unpaid_leave_min_days: '3',
      },
      async () => {
        await generate(under, [leaver.id]);
        const belowThreshold = await rowIn(shortMonth, under);
        expect(n(belowThreshold.amount), 'a two-day absence paused a three-day policy').toBeCloseTo(300, 2);
        expect(belowThreshold.reason).toBe('AFFORDABLE');

        await generate(over, [juggler.id]);
        const atThreshold = await rowIn(longMonth, over);
        expect(n(atThreshold.amount), 'the threshold itself did not trigger the policy').toBe(0);
        expect(atThreshold.reason).toBe('UNPAID_LEAVE');
        expect(atThreshold.outcome).toBe('SKIP');
      },
    );
  });

  test('strictest-wins across two overlapping leave types', async () => {
    test.skip(
      true,
      'UNREACHABLE over HTTP: the per-type policy lives in LibraryItem.loanDeductionPolicy, ' +
        'which is absent from CreateLibraryItemDto and UpdateLibraryItemDto and is never set by ' +
        'the seed — so every leave type resolves to null and the run-wide ' +
        'loan_unpaid_leave_policy is always what applies. STRICTNESS (CONTINUE < EXTEND < PAUSE) ' +
        'is covered by loan-recovery.service.spec.ts as a unit table. Expose the column on the ' +
        'library DTO and this becomes two overlapping leaves and one assertion.',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Several loans competing for one pool
// ───────────────────────────────────────────────────────────────────────────

/**
 * When the money runs out, ORDER is the whole answer.
 *
 * `sortCandidates` is deliberately total — priority, then type rank, then oldest
 * due cycle, then the configured tiebreak, then instalment number, then the id —
 * so "two loans of the same priority" can never depend on the order Postgres
 * happened to return rows in. The cases below constrain the pool so that the
 * order is observable rather than academic.
 */
test.describe('several live loans competing for one pool', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll generation is an administrative flow');
    test.skip(
      !flagFlipAllowed(),
      'a pool small enough for the order to matter only exists when loan_module_v2_enabled is on; run with E2E_ALLOW_FLAG_FLIP=1',
    );
  });

  test('two loans are both recovered when the pool covers them', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const [p] = reserve();
    const advance = await importLoan({
      employee: juggler,
      type: 'ADVANCE',
      principal: 500,
      firstDue: p,
      note: 'two loans — advance',
    });
    const loan = await importLoan({
      employee: juggler,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'two loans — loan',
    });

    await withSettings(adminApi, { loan_module_v2_enabled: 'true' }, async () => {
      const run = await generate(p, [juggler.id]);

      expect(n((await rowIn(advance, p)).amount)).toBeCloseTo(500, 2);
      expect(n((await rowIn(loan, p)).amount)).toBeCloseTo(300, 2);

      const item = await payrollItemFor(adminApi, run.id, juggler.id);
      expect(n(item?.advanceLoanDeduction)).toBeCloseTo(800, 2);
    });
  });

  test('when the pool covers only one, the default ADVANCE,LOAN order decides', async () => {
    const [p] = reserve();
    // Each instalment alone is affordable; together they are not. That is the
    // only arrangement in which the ORDER is observable.
    const emi = round2(NET * 0.3);
    const advance = await importLoan({
      employee: juggler,
      type: 'ADVANCE',
      principal: emi,
      firstDue: p,
      note: 'order — advance wins',
    });
    const loan = await importLoan({
      employee: juggler,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'order — loan loses',
    });

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'SKIP',
        // 40 % of net: enough for one 30 % instalment, not for two.
        loan_max_total_deduction_percent_of_net: '40',
      },
      async () => {
        await generate(p, [juggler.id]);

        // `loan_recovery_priority_order` defaults to ADVANCE,LOAN — employer
        // cash already out of the door comes back before money that is still
        // being lent.
        expect(n((await rowIn(advance, p)).amount)).toBeCloseTo(emi, 2);
        const loser = await rowIn(loan, p);
        expect(n(loser.amount)).toBe(0);
        expect(loser.outcome).toBe('SKIP');
        expect(loser.reason).toBe('INSUFFICIENT_NET');
      },
    );
  });

  test('flipping loan_recovery_priority_order reverses who gets paid', async () => {
    const [p] = reserve();
    const emi = round2(NET * 0.3);
    const advance = await importLoan({
      employee: juggler,
      type: 'ADVANCE',
      principal: emi,
      firstDue: p,
      note: 'order flipped — advance loses',
    });
    const loan = await importLoan({
      employee: juggler,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'order flipped — loan wins',
    });

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'SKIP',
        loan_max_total_deduction_percent_of_net: '40',
        loan_recovery_priority_order: 'LOAN,ADVANCE',
      },
      async () => {
        await generate(p, [juggler.id]);

        // Identical fixture to the previous case, one setting apart. If the
        // order were hard-coded rather than configured, both cases would still
        // pay the advance and only one of them would fail.
        expect(n((await rowIn(loan, p)).amount)).toBeCloseTo(emi, 2);
        expect(n((await rowIn(advance, p)).amount)).toBe(0);
      },
    );
  });

  test('three loans drain the pool in order until it is empty', async () => {
    const [p] = reserve();
    const emi = round2(NET * 0.2);
    const advance = await importLoan({
      employee: juggler,
      type: 'ADVANCE',
      principal: emi,
      firstDue: p,
      note: 'three — advance',
    });
    const older = await importLoan({
      employee: juggler,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'three — older loan',
    });
    const newer = await importLoan({
      employee: juggler,
      principal: emi,
      installments: 1,
      firstDue: p,
      note: 'three — newer loan',
    });

    await withSettings(
      adminApi,
      {
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'SKIP',
        // Room for two of the three 20 % instalments and nothing more.
        loan_max_total_deduction_percent_of_net: '45',
      },
      async () => {
        const run = await generate(p, [juggler.id]);

        // Advance first by type rank; then the two loans in creation order,
        // because `loan_priority_tiebreak` defaults to OLDEST_FIRST and both
        // fall due in the same cycle. The third is left entirely.
        expect(n((await rowIn(advance, p)).amount)).toBeCloseTo(emi, 2);
        expect(n((await rowIn(older, p)).amount)).toBeCloseTo(emi, 2);
        const last = await rowIn(newer, p);
        expect(n(last.amount), 'the third loan was funded out of a pool that was empty').toBe(0);
        expect(last.reason).toBe('INSUFFICIENT_NET');

        const item = await payrollItemFor(adminApi, run.id, juggler.id);
        expect(n(item?.advanceLoanDeduction)).toBeCloseTo(round2(emi * 2), 2);
      },
    );
  });

  test('the SMALLEST_BALANCE_FIRST tiebreak', async () => {
    test.skip(
      true,
      'UNREACHABLE with a safe teardown: loan_priority_tiebreak is writable but is NOT returned ' +
        'by GET /system-settings, so withSetting refuses it rather than restoring a guessed ' +
        'value — and a tiebreak left flipped silently reorders recovery for every later spec. ' +
        'Its default, OLDEST_FIRST, IS asserted by "three loans drain the pool in order". Add the ' +
        'key to SystemSettingsService.getSettingsList() and this becomes one more case.',
    );
  });

  test('a per-request priority overriding the type order', async () => {
    test.skip(
      true,
      'UNREACHABLE over HTTP: AdvanceLoanRequest.priority is read by sortCandidates as the FIRST ' +
        'sort key, but no DTO exposes it — not CreateAdvanceLoanDto, not the approve DTO, not the ' +
        'import row — so every request created through the API carries the schema default of 100 ' +
        'and the key can never differ between two loans. Covered as a unit table in ' +
        'loan-amortization.util.spec.ts.',
    );
  });

  test('one loan completes mid-cycle while its sibling carries on', async () => {
    const [p] = reserve();
    const finishing = await importLoan({
      employee: juggler,
      principal: 300,
      installments: 1,
      firstDue: p,
      note: 'sibling — finishing',
    });
    const continuing = await importLoan({
      employee: juggler,
      principal: 1200,
      installments: 4,
      firstDue: p,
      note: 'sibling — continuing',
    });

    await withSettings(adminApi, { loan_module_v2_enabled: 'true' }, async () => {
      await generateAndLock(p, [juggler.id]);

      // The auto-close sweep runs over every request the run touched and closes
      // only those whose balance has actually gone. A sweep that closed the run
      // rather than the loan would take the second one with it.
      await expect
        .poll(async () => (await loanOf(adminApi, finishing)).status, { timeout: 20_000 })
        .toBe('COMPLETED');
      const alive = await loanOf(adminApi, continuing);
      expect(alive.status, 'the sibling was closed along with the finished loan').not.toBe('COMPLETED');
      expect(n(alive.amountRepaid)).toBeCloseTo(300, 2);
    });
  });

  test('a held loan is passed over while its sibling is recovered', async () => {
    const [p] = reserve();
    const held = await importLoan({
      employee: juggler,
      principal: 1200,
      installments: 4,
      firstDue: p,
      status: 'ON_HOLD',
      note: 'sibling — held',
    });
    const running = await importLoan({
      employee: juggler,
      principal: 900,
      installments: 3,
      firstDue: p,
      note: 'sibling — running',
    });

    await withSettings(adminApi, { loan_module_v2_enabled: 'true' }, async () => {
      const run = await generate(p, [juggler.id]);

      // Excluded by `LOAN_RECOVERABLE_STATUSES` before the allocator is reached,
      // so it does not even compete for the pool — the sibling gets the whole
      // instalment rather than sharing it with a loan nobody is collecting.
      expect(await rowsIn(held, p)).toEqual([]);
      expect(n((await rowIn(running, p)).amount)).toBeCloseTo(300, 2);

      const item = await payrollItemFor(adminApi, run.id, juggler.id);
      expect(n(item?.advanceLoanDeduction)).toBeCloseTo(300, 2);
    });
  });
});
