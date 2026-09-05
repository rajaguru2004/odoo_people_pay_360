import { test, expect, settle, ApiClient } from '../../fixtures';
import { LoanLifecyclePage, selectBranch } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  deductionsFor,
  ensureAllowance,
  loanOf,
  makeEmployee,
  marker,
  quoteOf,
  retire,
  retireAllMarked,
  runPayroll,
  lockPayroll,
  unlockPayroll,
  deletePayroll,
  clearPayrolls,
  scheduleOf,
  terminateEmployee,
  TestEmployee,
} from '../../loan-support';

/**
 * §18 of the catalogue — DATA INTEGRITY — and the ledger invariants underneath
 * it.
 *
 * Every other loan spec asks "did the operation do what it said?". This one
 * asks the question that only shows up months later: **is anything ever lost?**
 * An employee leaves, moves department, a payroll is deleted, a schedule is
 * re-planned twice, a settlement is reversed — and afterwards the loan book must
 * still add up. A regression here is silent by construction: nothing on screen
 * changes, no request 500s, and the first symptom is an auditor asking why the
 * receivable ledger disagrees with the loans it is a ledger of.
 *
 * ## The three invariants asserted after EVERY mutation in this file
 *
 *   1. **Balance identity** — `outstanding = amount − amountRepaid −
 *      writtenOffAmount − waivedAmount`, and the payoff quote agrees with it,
 *      and the still-SCHEDULED schedule rows sum to it. Written once as
 *      `assertBalancesAgree` and called after every operation rather than at the
 *      end, so a drift is attributed to the operation that caused it instead of
 *      to whichever one happened to be last.
 *   2. **The deduction split** — `principalComponent + interestComponent +
 *      feeComponent === amount` on every ledger row. This is a DB CHECK
 *      (`advance_loan_deductions_split_chk`), so a violation would surface as an
 *      exception rather than as a wrong number; it is asserted explicitly anyway
 *      so that a regression is NAMED instead of arriving as an opaque P2010 from
 *      a payroll run three files away.
 *   3. **Append-only** — a reversal ADDS a row and never edits one. Asserted by
 *      capturing the whole transaction stream before and comparing it
 *      field-for-field after.
 *
 * ## Why almost everything here is an API test
 *
 * Retention is not a screen. "The superseded schedule row is still in the
 * database" has no pixel, and driving it through a browser would only add a
 * render to a claim that is entirely about persistence. The two browser cases
 * that DO exist are the ones where the claim is visual: that a loan belonging to
 * somebody who has left still renders for an administrator, and that the two
 * empty states say different things.
 *
 * ## How the subjects are made, and why it is not `liveLoan`
 *
 * `POST /advance-loans` files a request for **the caller** — the route is
 * `@Roles('HR_MANAGER','MANAGER','EMPLOYEE')` and reads `user.employeeId`, so an
 * ADMIN cannot file on anyone's behalf. And an API-created employee cannot log
 * in at all (`makeEmployee`'s `NO_LOGIN`: `POST /employees` mints a random
 * temporary password that no endpoint returns).
 *
 * The way out is the IMPORTER: `POST /advance-loans/import/confirm` takes plain
 * JSON rows keyed by employee CODE, runs the same amortization engine, writes
 * the schedule, the PAID history rows and a DISBURSEMENT transaction, and is
 * `@Roles('ADMIN','HR_MANAGER')`. So `importLoan()` below is how this file gives
 * a freshly made employee a real, mid-life loan without ever needing a session
 * for them — which is precisely what a spec that TERMINATES and DELETES its
 * subjects needs, because it must never touch the four seeded role accounts.
 *
 * One state is therefore out of reach: **PENDING**. Only the borrower can file a
 * request, the importer only admits ACTIVE / CLOSED / ON_HOLD, and an
 * API-created employee has no login — so "a PENDING request blocks the delete"
 * is asserted against the one account that CAN file, rather than against a made
 * employee.
 *
 * ## Branch choice is contention control, not decoration
 *
 * A payroll run is per-branch and the recovery planner sweeps arrears forward,
 * so generating one for HO attaches a PENDING deduction to every live loan in
 * HO — including the ones `finance-loan-lifecycle.spec.ts` is halfway through
 * operating on in another worker, which then refuses every operation with
 * "Payroll n/yyyy is in progress". Every loan this file operates on therefore
 * lives in **E2E-BR2**, and the one payroll run it makes is additionally
 * narrowed with `employeeIds` to a single person. Only the department-visibility
 * subjects live in HO, because that is the only branch the seeded MANAGERs can
 * see, and nothing is ever recovered against them.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string): boolean => test.info().project.name === name;

/** The stable half of the marker — what identifies a record as THIS file's. */
const MARKER_PREFIX = 'pw-loandata-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const MARK = marker(MARKER_PREFIX);

// ───────────────────────────────────────────────────────────────────────────
// Reading a loan without pretending to know its exact type
// ───────────────────────────────────────────────────────────────────────────

/**
 * `loanOf` returns the whole detail payload as an open record on purpose (the
 * route includes employee, approver, attachments and deductions, and every spec
 * wants a different corner). These are the corners THIS file wants.
 */
interface LoanFacts {
  id: string;
  status: string;
  type: string;
  amount: number;
  amountRepaid: number;
  writtenOffAmount: number;
  waivedAmount: number;
  outstandingPrincipal: number;
  outstandingInterest: number;
  scheduleVersion: number;
  installments: number;
  closureType: string | null;
  closedAt: string | null;
  settlementMode: string | null;
  convertedFromId: string | null;
  referenceNo: string | null;
  employeeId: string;
  employeeCodeSnapshot: string | null;
  employeeNameSnapshot: string | null;
}

/** Decimal columns cross the wire as strings. This is the one place that admits it. */
const num = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

async function factsOf(api: ApiClient, id: string): Promise<LoanFacts> {
  const raw = await loanOf(api, id);
  return {
    id: String(raw.id ?? id),
    status: String(raw.status ?? ''),
    type: String(raw.type ?? ''),
    amount: num(raw.amount),
    amountRepaid: num(raw.amountRepaid),
    writtenOffAmount: num(raw.writtenOffAmount),
    waivedAmount: num(raw.waivedAmount),
    outstandingPrincipal: num(raw.outstandingPrincipal),
    outstandingInterest: num(raw.outstandingInterest),
    scheduleVersion: Number(raw.scheduleVersion ?? 0),
    installments: Number(raw.installments ?? 0),
    closureType: str(raw.closureType),
    closedAt: str(raw.closedAt),
    settlementMode: str(raw.settlementMode),
    convertedFromId: str(raw.convertedFromId),
    referenceNo: str(raw.referenceNo),
    employeeId: String(raw.employeeId ?? ''),
    employeeCodeSnapshot: str(raw.employeeCodeSnapshot),
    employeeNameSnapshot: str(raw.employeeNameSnapshot),
  };
}

/** One row of the payroll repayment ledger, as the detail route includes it. */
interface DeductionFacts {
  id: string;
  amount: number;
  principalComponent: number;
  interestComponent: number;
  feeComponent: number;
  status: string;
  month: number;
  year: number;
}

async function ledgerRows(api: ApiClient, loanId: string): Promise<DeductionFacts[]> {
  const rows = (await deductionsFor(api, loanId)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    amount: num(r.amount),
    principalComponent: num(r.principalComponent),
    interestComponent: num(r.interestComponent),
    feeComponent: num(r.feeComponent),
    status: String(r.status ?? ''),
    month: Number(r.month ?? 0),
    year: Number(r.year ?? 0),
  }));
}

/**
 * One money event, as the employee statement reports it.
 *
 * The statement is the ONLY route that returns `LoanTransaction` rows — there is
 * no `/advance-loans/:id/transactions`. It carries no row id, which is exactly
 * why the append-only assertions below compare the ORDERED PREFIX of the stream
 * rather than matching rows up by key: if a reversal had edited its original in
 * place, the prefix would differ.
 */
interface TxnFacts {
  type: string;
  transactionDate: string;
  amount: number;
  principalComponent: number;
  interestComponent: number;
  narration: string | null;
  status: string;
}

/** Every loan of one employee, with its schedule and its money events. */
async function statementOf(
  admin: ApiClient,
  employeeId: string,
): Promise<Array<{ id: string; status: string; transactions: TxnFacts[] }>> {
  const raw = await admin.get<unknown>(
    `/advance-loans/reports/employee/${employeeId}/statement`,
  );
  const box = raw as { data?: unknown } | null;
  const list = (Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box!.data : []) as Array<
    Record<string, unknown>
  >;
  return list.map((l) => ({
    id: String(l.id ?? ''),
    status: String(l.status ?? ''),
    transactions: (Array.isArray(l.transactions) ? l.transactions : []).map(
      (t: Record<string, unknown>) => ({
        type: String(t.type ?? ''),
        transactionDate: String(t.transactionDate ?? ''),
        amount: num(t.amount),
        principalComponent: num(t.principalComponent),
        interestComponent: num(t.interestComponent),
        narration: str(t.narration),
        status: String(t.status ?? ''),
      }),
    ),
  }));
}

async function txnsOf(admin: ApiClient, employeeId: string, loanId: string): Promise<TxnFacts[]> {
  const loans = await statementOf(admin, employeeId);
  return loans.find((l) => l.id === loanId)?.transactions ?? [];
}

// ───────────────────────────────────────────────────────────────────────────
// The invariants, as reusable assertions
// ───────────────────────────────────────────────────────────────────────────

/**
 * The balance identity, the payoff quote and the remaining plan must all be
 * telling the same story.
 *
 * Called after EVERY mutation in this file. Three separate claims that a single
 * "outstanding is 400" assertion would conflate:
 *
 *   • the loan's own columns are self-consistent;
 *   • `payoffQuote` — which recomputes from those columns plus accrued interest
 *     — agrees with them, so the number an operator is quoted is the number the
 *     record holds;
 *   • the still-SCHEDULED rows of the LIVE schedule sum to the outstanding
 *     principal, so payroll will eventually collect exactly the balance and not
 *     a penny more. Only asserted when live rows remain — a closed or fully
 *     forgiven loan legitimately has none, and demanding one there would fail
 *     every terminal state for the wrong reason.
 */
async function assertBalancesAgree(api: ApiClient, loanId: string, when: string): Promise<void> {
  const loan = await factsOf(api, loanId);
  const identity =
    loan.amount - loan.amountRepaid - loan.writtenOffAmount - loan.waivedAmount;

  const quote = await quoteOf(api, loanId);
  expect(
    quote.outstandingPrincipal,
    `${when}: the payoff quote (${quote.outstandingPrincipal}) disagrees with ` +
      `amount − repaid − writtenOff − waived (${identity})`,
  ).toBeCloseTo(Math.max(0, identity), 2);

  // `outstandingPrincipal` is the denormalised counter LoanLedgerService owns.
  // It exists precisely so reports need not recompute — which is worthless if
  // it can drift from the arithmetic it stands in for.
  expect(
    loan.outstandingPrincipal,
    `${when}: the denormalised outstandingPrincipal drifted from the identity`,
  ).toBeCloseTo(Math.max(0, identity), 2);

  const rows = await scheduleOf(api, loanId);
  const live = rows.filter((r) => r.status === 'SCHEDULED');
  if (live.length > 0) {
    const planned = live.reduce((a, r) => a + r.principalComponent, 0);
    expect(
      planned,
      `${when}: the ${live.length} instalment(s) still to be collected sum to ` +
        `${planned} of principal, but ${identity} is outstanding`,
    ).toBeCloseTo(Math.max(0, identity), 1);
  }
}

/**
 * The DB CHECK, asserted from this side so a regression is named.
 *
 * `advance_loan_deductions_split_chk` asserts `principal + interest + fee =
 * amount` at write time, so a violation cannot reach the table — it arrives as
 * a constraint error from whatever payroll run tripped it, in a file that has
 * nothing to do with the engine that miscomputed the split. Reading the rows
 * back and checking the same sum turns that into an assertion with a name.
 */
async function assertSplitsSum(api: ApiClient, loanId: string, when: string): Promise<void> {
  for (const row of await ledgerRows(api, loanId)) {
    const parts = row.principalComponent + row.interestComponent + row.feeComponent;
    expect(
      parts,
      `${when}: deduction ${row.month}/${row.year} (${row.status}) splits into ` +
        `${row.principalComponent}+${row.interestComponent}+${row.feeComponent}=${parts}, ` +
        `but its amount is ${row.amount}`,
    ).toBeCloseTo(row.amount, 2);
  }
}

/** Both invariants, for the common case of "assert everything after this op". */
async function assertIntegrity(api: ApiClient, loanId: string, when: string): Promise<void> {
  await assertBalancesAgree(api, loanId, when);
  await assertSplitsSum(api, loanId, when);
}

// ───────────────────────────────────────────────────────────────────────────
// Giving an API-created employee a real loan
// ───────────────────────────────────────────────────────────────────────────

interface ImportSpec {
  code: string;
  principal: number;
  installments?: number;
  type?: 'LOAN' | 'ADVANCE';
  status?: 'ACTIVE' | 'CLOSED' | 'ON_HOLD';
  installmentsPaid?: number;
  amountRepaid?: number;
  /** `YYYY-MM`. Defaults to a period already in the past, so instalments are due. */
  firstDeductionPeriod?: string;
  note?: string;
}

/**
 * A syntactically valid v4 UUID, for the prepayment replay guard.
 *
 * Built here rather than imported: `crypto.randomUUID` is available at run time
 * but pulling `@types/node`'s global into this file for one call is a worse
 * trade than eight lines that are obviously correct.
 */
function uuidV4(): string {
  const hex = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}

/** A reference number the importer will accept: uppercase, no spaces, unique. */
let referenceSeq = 0;
const nextReference = (): string =>
  `LN-${MARK}-${(referenceSeq += 1)}`.toUpperCase().replace(/[^A-Z0-9/_-]/g, '-');

/**
 * Creates a mid-life loan for ANY employee, as ADMIN, over HTTP.
 *
 * `POST /advance-loans/import/confirm` takes the preview's `data` objects as
 * plain JSON — there is no file on this path, only `preview` is multipart — so a
 * spec can hand it rows it built itself. `confirm` validates nothing (that is
 * `preview`'s job), which is what makes it usable as a fixture factory and also
 * why every field below is supplied explicitly rather than left to a default
 * that does not exist.
 */
async function importLoan(admin: ApiClient, spec: ImportSpec): Promise<string> {
  const referenceNo = nextReference();
  const row = {
    employeeCode: spec.code,
    referenceNo,
    type: spec.type ?? 'LOAN',
    principal: spec.principal,
    interestMethod: 'NONE',
    interestRate: 0,
    installments: spec.installments ?? 6,
    emi: null,
    // Comfortably after every seeded start date and comfortably in the past, so
    // the validator's "disbursed before the employee joined" rule is satisfied
    // and the instalments are genuinely due.
    disbursedOn: '2024-06-01',
    firstDeductionPeriod: spec.firstDeductionPeriod ?? '2024-07',
    installmentsPaid: spec.installmentsPaid ?? 0,
    amountRepaid: spec.amountRepaid ?? 0,
    status: spec.status ?? 'ACTIVE',
    notes: `${MARK} — ${spec.note ?? 'data-integrity subject'}`,
  };

  const raw = await admin.post<unknown>('/advance-loans/import/confirm', { rows: [row] });
  const box = raw as { results?: unknown; data?: { results?: unknown } } | null;
  const results = (Array.isArray(box?.results)
    ? box!.results
    : Array.isArray(box?.data?.results)
      ? box!.data!.results
      : []) as Array<{ success: boolean; loanId?: string; error?: string }>;

  const hit = results[0];
  if (!hit?.success || !hit.loanId) {
    throw new Error(
      `import/confirm created no loan for ${spec.code}: ${hit?.error ?? JSON.stringify(raw)}`,
    );
  }
  return hit.loanId;
}

/** Every employee this file made, terminated and swept in `afterAll`. */
const made: TestEmployee[] = [];

async function subject(
  admin: ApiClient,
  opts: { branchId: string; departmentId?: string; suffix: string },
): Promise<TestEmployee> {
  const emp = await makeEmployee(admin, {
    marker: `${MARK}${opts.suffix}`,
    branchId: opts.branchId,
    departmentId: opts.departmentId,
    baseSalary: 60000,
  });
  made.push(emp);
  return emp;
}

/**
 * Leaves nothing live behind.
 *
 * The loans go first: `retireAllMarked` writes off anything of this file's that
 * still counts as open, and only then are the people marked as having left —
 * `terminateEmployee` always supplies the clearance override, so the order is
 * not load-bearing for the delete itself, but it keeps the audit trail honest
 * (an exit overridden past a balance that was about to be written off anyway is
 * a misleading record).
 */
async function sweep(admin: ApiClient): Promise<void> {
  await retireAllMarked(admin, MARKER_PREFIX).catch(() => undefined);
  for (const emp of made) {
    await terminateEmployee(admin, emp.id).catch(() => undefined);
  }
  made.length = 0;
}

/** The departments the seeded MANAGERs head, by code. */
async function departmentIdByCode(admin: ApiClient, code: string): Promise<string> {
  const raw = await admin.get<unknown>('/departments');
  const box = raw as { data?: unknown } | null;
  const list = (Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box!.data : []) as Array<{
    id: string;
    code: string;
  }>;
  const hit = list.find((d) => d.code === code);
  if (!hit) {
    throw new Error(
      `No department with code "${code}" (saw: ${list.map((d) => d.code).join(', ') || 'none'}). ` +
        'E2E-OPS and HRD come from seed-e2e-baseline.ts.',
    );
  }
  return hit.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Offboarding: what a loan does to an exit, and what an exit does to a loan
// ───────────────────────────────────────────────────────────────────────────

/**
 * The two gates on ending an employment, and the fact that neither destroys the
 * loan.
 *
 * They are genuinely different controls and are often confused:
 *
 *   • `DELETE /employees/:id` is a SOFT delete (status → INACTIVE, R72). What
 *     stops it is `ClearanceService.assertCleared` — a policy check, driven by
 *     `loan_clearance_blocking_enabled`, which an ADMIN can override with a
 *     reason. Nothing referential happens.
 *   • `DELETE /employees/:id/hard` actually removes the row, so every FK fires —
 *     and `AdvanceLoanRequest.employee` is `onDelete: Restrict`. That one is not
 *     overridable by anybody, because it is the database refusing, mirrored by
 *     an application-level count so the message is readable instead of a P2003.
 *
 * The second is the one the schema comment is about ("loan history must survive
 * the employee record for statutory audit"), and it is why the terminal states
 * are worth testing: a CLOSED loan stops blocking the SOFT delete the moment it
 * stops owing money, and still blocks the HARD one forever, because a terminal
 * loan is still a row.
 */
test.describe('an exit cannot quietly take a loan with it', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  /** Everything about the loan that an exit must not change. */
  let before: LoanFacts | null = null;
  let beforeSchedule: unknown = null;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'exit' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 600,
        installments: 6,
        note: 'the exit gate',
      });
      before = await factsOf(adminApi, loanId);
      beforeSchedule = JSON.stringify(await scheduleOf(adminApi, loanId));
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'offboarding and the loan book are an ADMIN surface');
  });

  test('an exit is refused while the loan still owes money, and the loan is untouched', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // No `clearanceOverrideReason`: this is the door as an ordinary offboarding
    // meets it. The refusal has to name the OBLIGATION — a count of assets when
    // the blocker is a loan sends the reader hunting for hardware.
    await expect(adminApi.delete(`/employees/${emp!.id}`)).rejects.toThrow(
      /outstanding advance\/loan balance/i,
    );

    const employee = await adminApi.get<{ status: string }>(`/employees/${emp!.id}`);
    expect(employee.status, 'a refused offboarding ended the employment anyway').toBe('ACTIVE');

    const after = await factsOf(adminApi, loanId);
    expect(after, 'the refused exit changed the loan').toEqual(before);
    await assertIntegrity(adminApi, loanId, 'after a refused exit');
  });

  test('an overridden exit lets the person leave and leaves the loan exactly as it was', async () => {
    test.skip(!loanId, 'no loan to carry through the exit');

    // The escape hatch, which is audited rather than absent: a tender needs the
    // block, an administrator needs the override, and the auditor needs to see
    // which was used. `terminateEmployee` always supplies the reason.
    await terminateEmployee(adminApi, emp!.id);

    const employee = await adminApi.get<{ status: string; endDate: string | null }>(
      `/employees/${emp!.id}`,
    );
    // R72: all three offboarding paths write INACTIVE. TERMINATED is a CONTRACT
    // status and nothing else.
    expect(employee.status).toBe('INACTIVE');
    expect(employee.endDate, 'the exit was recorded without a leaving date').toBeTruthy();

    const after = await factsOf(adminApi, loanId);
    expect(after, 'the exit restated the loan').toEqual(before);
    expect(
      JSON.stringify(await scheduleOf(adminApi, loanId)),
      'the exit rewrote the repayment plan',
    ).toBe(beforeSchedule);
    await assertIntegrity(adminApi, loanId, 'after the exit');
  });

  test('a permanent delete is refused because the loan row must be retained', async () => {
    test.skip(!loanId, 'no loan to protect');

    // THE `onDelete: Restrict` claim. `allow_hard_delete_terminated` is pinned
    // true in the e2e baseline and the employee is INACTIVE, so the only thing
    // left standing between the caller and `employee.delete()` is the loan — and
    // the refusal is the application-level count that exists so this reads as a
    // sentence instead of a raw P2003.
    await expect(adminApi.delete(`/employees/${emp!.id}/hard`)).rejects.toThrow(
      /statutory audit/i,
    );

    // Both halves survive, which is the whole point: the person is still there
    // to attach the history to, and the history is still attached.
    const employee = await adminApi.get<{ id: string }>(`/employees/${emp!.id}`);
    expect(employee.id).toBe(emp!.id);
    expect(await factsOf(adminApi, loanId), 'the refused delete changed the loan').toEqual(before);
  });
});

/**
 * The same permanent-delete refusal, for loans that are FINISHED.
 *
 * A terminal loan no longer owes anything, so it stops blocking the soft delete
 * — that is the clearance policy working as designed. It must still block the
 * hard one, because `Restrict` is about the ROW existing, not about the balance.
 * This is the case a "tidy up closed loans" migration would break first.
 */
test.describe('a finished loan is still a row, and still cannot be deleted away', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'offboarding and the loan book are an ADMIN surface');
  });

  for (const state of ['CLOSED', 'ON_HOLD', 'WRITTEN_OFF'] as const) {
    test(`a ${state} loan blocks the permanent delete and survives the attempt`, async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const emp = await subject(adminApi, {
        branchId,
        suffix: state.toLowerCase().replace(/[^a-z]/g, ''),
      });

      // WRITTEN_OFF is not importable — the importer admits ACTIVE, CLOSED and
      // ON_HOLD only — so it is reached the way a real one is: an ACTIVE loan
      // that an ADMIN forgave.
      const importable = state === 'WRITTEN_OFF' ? 'ACTIVE' : state;
      const loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 400,
        installments: 4,
        status: importable,
        note: `terminal state ${state}`,
      });

      if (state === 'WRITTEN_OFF') {
        await adminApi.post(`/advance-loans/${loanId}/write-off`, {
          reason: `${MARK} uncollectable, for the retention journey`,
        });
        await assertIntegrity(adminApi, loanId, 'after the write-off');
      }

      const loan = await factsOf(adminApi, loanId);
      expect(loan.status, 'the subject is not in the state this case is about').toBe(state);

      await terminateEmployee(adminApi, emp.id);
      const snapshot = await factsOf(adminApi, loanId);

      await expect(adminApi.delete(`/employees/${emp.id}/hard`)).rejects.toThrow(
        /statutory audit/i,
      );
      expect(
        await factsOf(adminApi, loanId),
        'the refused permanent delete still moved the loan',
      ).toEqual(snapshot);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// After the exit: the loan is still reportable, and still renders
// ───────────────────────────────────────────────────────────────────────────

/**
 * "Archived employees retain accurate loan history for statutory audits."
 *
 * Two halves, and they are not the same claim. The REPORT half is machine
 * readable and is what an auditor actually pulls; the SCREEN half is what an
 * administrator does when the auditor asks a follow-up question, and it breaks
 * differently — a detail route that assumed an ACTIVE employee renders a blank
 * page rather than a wrong number.
 *
 * The snapshot columns are the third half. `AdvanceLoanRequest` carries
 * `employeeCodeSnapshot` / `employeeNameSnapshot` explicitly so the history
 * survives the person, and whether they are populated depends entirely on HOW
 * the loan was created — which is asserted rather than assumed, because it is
 * exactly the kind of thing that is believed to be true and is not.
 */
test.describe('a loan outlives the employment it belongs to', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let importedId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'archive' });
      importedId = await importLoan(adminApi, {
        code: emp.code,
        principal: 900,
        installments: 9,
        installmentsPaid: 2,
        amountRepaid: 200,
        note: 'archived employee history',
      });
      await terminateEmployee(adminApi, emp.id);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book and its reports are an ADMIN surface');
  });

  test('the outstanding report still carries a leaver, and the name snapshot resolves', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const loan = await factsOf(adminApi, importedId);
    expect(loan.status, 'the exit changed the loan status').toBe('ACTIVE');
    await assertIntegrity(adminApi, importedId, 'after the employee left');

    // The statutory-audit claim, asserted against the report an auditor pulls.
    // `outstanding` deliberately carries NO employee-status filter — a leaver's
    // receivable is still a receivable.
    const raw = await adminApi.get<unknown>('/advance-loans/reports/outstanding?limit=200');
    const box = raw as { data?: unknown } | null;
    const rows = (Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box!.data : []) as Array<{
      employeeId: string;
      outstanding: number;
      employeeName: string;
    }>;
    const mine = rows.find((r) => r.employeeId === emp!.id);
    expect(mine, 'the report dropped a terminated employee and with them their balance')
      .toBeTruthy();
    expect(mine!.outstanding).toBeCloseTo(
      loan.amount - loan.amountRepaid - loan.writtenOffAmount - loan.waivedAmount,
      2,
    );

    // The snapshot columns exist so the history reads correctly once the person
    // is gone. The IMPORTER writes them; nothing else in the module does — see
    // docs/LOAN-ADVANCES-GAP-REPORT.md §18. Asserted from both sides so the
    // asymmetry is a stated fact rather than a surprise.
    expect(loan.employeeCodeSnapshot, 'the importer stopped snapshotting the code').toBe(emp!.code);
    expect(loan.employeeNameSnapshot, 'the importer stopped snapshotting the name').toBeTruthy();
  });

  test('a natively filed loan carries the same snapshot the importer writes', async () => {
    const owner = await ApiClient.as('employee');
    let nativeId = '';
    try {
      // The seeded requester lives in HO while this describe is scoped to
      // E2E-BR2, and `withBranch` MUTATES the client — so the admin view has to
      // be widened before it is used against an HO loan, and put back after.
      adminApi.withBranch(null);
      await ensureAllowance(owner, adminApi, 300, MARKER_PREFIX);
      const created = await owner.post<{ id: string; employeeId: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 300,
        installments: 3,
        reason: `${MARK} — snapshot check on a natively filed request`,
      });
      nativeId = created.id;

      const loan = await factsOf(adminApi, nativeId);
      // `employeeCodeSnapshot` / `employeeNameSnapshot` are kept so a loan can
      // be reported on after its employee is archived. They used to be written
      // only by the importer, which left every natively filed loan depending on
      // the live join the snapshot exists to remove. Both paths write them now.
      expect(
        loan.employeeCodeSnapshot,
        'a natively filed loan did not snapshot the employee code',
      ).toBe('EMP001');
      expect(loan.employeeNameSnapshot, 'no name snapshot on a natively filed loan').toBeTruthy();
    } finally {
      if (nativeId) await retire(nativeId, owner, adminApi);
      await owner.dispose();
      adminApi.withBranch(branchId);
    }
  });

  test('the detail page still renders for an administrator after the person has left', async ({
    page,
    problems,
  }) => {
    test.skip(!importedId, 'no loan to open');

    await selectBranch(page, branchId);
    const detail = new LoanLifecyclePage(page);
    await detail.open(importedId);

    // The status is what proves the whole route rendered — a page still loading
    // and a page that failed to load look identical from a bare selector.
    await detail.expectStatus('ACTIVE');

    const loan = await factsOf(adminApi, importedId);
    const outstanding =
      loan.amount - loan.amountRepaid - loan.writtenOffAmount - loan.waivedAmount;
    // Read from `data-value`, never from the rendered currency: `formatCurrency`
    // inserts a locale separator and a symbol, so parsing it asserts `Intl`.
    await expect
      .poll(() => detail.summary('outstanding'), { timeout: 15_000 })
      .toBeCloseTo(outstanding, 2);

    // The imported PAID history is what payroll reads to know where to resume.
    // If it did not render, the screen would be claiming nothing was ever
    // recovered from somebody who has already repaid two instalments.
    expect(await detail.ledgerIsEmpty(), 'the recovery history vanished with the employee')
      .toBe(false);
    expect(await detail.scheduleRowCount()).toBeGreaterThan(0);

    settle(problems, 'the loan detail page for an employee who has left');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The loan follows the person
// ───────────────────────────────────────────────────────────────────────────

/**
 * A department change mid-loan, from the only angle that can be wrong.
 *
 * The loan carries no department of its own — `LoanAccessService` resolves it
 * through `request.employee.departmentId`, and the outstanding report joins
 * `employees.department_id`. So "the loan follows the employee" is not a copy
 * being kept in sync; it is the absence of a copy. What that buys, and what is
 * asserted here, is that the visibility flips ATOMICALLY: the old department's
 * manager loses the loan at the same instant the new one gains it, with no
 * window in which both or neither can see it.
 *
 * Both seeded MANAGERs are used because one alone proves the wrong thing. A
 * manager who can no longer see a loan might simply have lost access to
 * everything; a manager who can now see it might always have been able to.
 */
test.describe('a department change carries the loan with the employee', () => {
  let adminApi: ApiClient;
  let hrdManager: ApiClient;
  let opsManager: ApiClient;
  let hoBranchId = '';
  let hrdId = '';
  let opsId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoBranchId = await branchIdByCode(adminApi, 'HO');
      adminApi.withBranch(hoBranchId);
      hrdId = await departmentIdByCode(adminApi, 'HRD');
      opsId = await departmentIdByCode(adminApi, 'E2E-OPS');

      // `manager@company.com` heads HRD; `manager2@company.com` heads E2E-OPS.
      // Both live in HO and neither is in ROLE_ACCOUNTS' four, so the second one
      // comes through `asAccount` — the same door `employee2` uses.
      hrdManager = (await ApiClient.as('manager')).withBranch(hoBranchId);
      opsManager = (
        await ApiClient.asAccount('manager2@company.com', 'Password123!')
      ).withBranch(hoBranchId);

      emp = await subject(adminApi, {
        branchId: hoBranchId,
        departmentId: hrdId,
        suffix: 'dept',
      });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 500,
        installments: 5,
        note: 'department transfer',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await hrdManager?.dispose();
    await opsManager?.dispose();
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the move is administered, and the assertions need ADMIN too');
  });

  test('the manager who could see it loses it, the new one gains it, and the report follows', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const reportHas = async (departmentId: string): Promise<boolean> => {
      const raw = await adminApi.get<unknown>(
        `/advance-loans/reports/outstanding?limit=200&departmentId=${departmentId}`,
      );
      const box = raw as { data?: unknown } | null;
      const rows = (Array.isArray(raw) ? raw : Array.isArray(box?.data) ? box!.data : []) as Array<{
        employeeId: string;
      }>;
      return rows.some((r) => r.employeeId === emp!.id);
    };
    const canSee = async (api: ApiClient): Promise<boolean> =>
      api
        .get(`/advance-loans/${loanId}`)
        .then(() => true)
        .catch(() => false);

    // Before: HRD's manager can read it, OPS's cannot, and the report files it
    // under HRD.
    expect(await canSee(hrdManager), 'the HRD manager could not see a loan in their own department')
      .toBe(true);
    expect(await canSee(opsManager), 'a manager outside the department could already see it')
      .toBe(false);
    expect(await reportHas(hrdId)).toBe(true);
    expect(await reportHas(opsId)).toBe(false);

    const beforeMove = await factsOf(adminApi, loanId);

    // The move itself. `departmentId` is on `UpdateEmployeeDto`; `branchId` is
    // deliberately NOT — see the branch describe below.
    await adminApi.patch(`/employees/${emp!.id}`, { departmentId: opsId });

    // After: exactly the mirror image. Polled because both answers are derived
    // from the employee row the PATCH just wrote.
    await expect
      .poll(() => canSee(opsManager), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(() => canSee(hrdManager), { timeout: 15_000 })
      .toBe(false);
    await expect.poll(() => reportHas(opsId), { timeout: 15_000 }).toBe(true);
    expect(await reportHas(hrdId), 'the loan is reported under both departments at once')
      .toBe(false);

    // And the loan itself did not move a penny while its visibility did.
    expect(await factsOf(adminApi, loanId), 'the department change restated the loan')
      .toEqual(beforeMove);
    await assertIntegrity(adminApi, loanId, 'after the department change');
  });
});

/**
 * Branch scoping, which is the harder half of the same idea — and the half that
 * cannot be driven end to end.
 *
 * `UpdateEmployeeDto` deliberately omits `branchId` ("moving an employee between
 * branches crosses the isolation axis … needs its own reviewed flow"), and the
 * global pipe runs `forbidNonWhitelisted`, so sending it is a 400 rather than a
 * transfer. There is no other route that writes `Employee.branchId` either. So
 * the TRANSFER is skipped and reported rather than faked.
 *
 * What is still fully assertable, and is what a transfer would have to preserve,
 * is that a loan's branch envelope is derived CONSISTENTLY. `BRANCH_SCOPE` maps
 * `AdvanceLoanRequest` through `employee`, and `LoanSchedule` / `LoanTransaction`
 * / `AdvanceLoanDeduction` through `request → employee` — three separate rules
 * that must agree, because a schedule readable from a branch whose loan is not
 * is a leak of the instalment amounts the loan was hiding.
 */
test.describe('a loan, its plan and its ledger share one branch envelope', () => {
  let adminApi: ApiClient;
  let hoBranchId = '';
  let br2BranchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      hoBranchId = await branchIdByCode(adminApi, 'HO');
      br2BranchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(br2BranchId);
      emp = await subject(adminApi, { branchId: br2BranchId, suffix: 'branch' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 480,
        installments: 4,
        installmentsPaid: 1,
        amountRepaid: 120,
        note: 'branch envelope',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'cross-branch reads need a caller with access to both');
  });

  test('the loan, its schedule and its ledger are all invisible from the other branch', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const from = async (branchId: string, path: string): Promise<boolean> =>
      adminApi
        .withBranch(branchId)
        .get(path)
        .then(() => true)
        .catch(() => false);

    // Visible from its own branch — all three routes, because they are scoped by
    // three DIFFERENT rules and only agreeing by construction.
    expect(await from(br2BranchId, `/advance-loans/${loanId}`)).toBe(true);
    expect(await from(br2BranchId, `/advance-loans/${loanId}/schedule`)).toBe(true);
    expect(await from(br2BranchId, `/advance-loans/${loanId}/payoff-quote`)).toBe(true);
    expect((await ledgerRows(adminApi.withBranch(br2BranchId), loanId)).length).toBeGreaterThan(0);

    // And invisible from the other one. A 404 rather than a 403 is the designed
    // answer: existence must not leak across the isolation axis.
    expect(
      await from(hoBranchId, `/advance-loans/${loanId}`),
      'a loan in E2E-BR2 was readable while scoped to HO',
    ).toBe(false);
    expect(
      await from(hoBranchId, `/advance-loans/${loanId}/schedule`),
      'the schedule leaked the instalments of a loan the same caller cannot read',
    ).toBe(false);
    expect(
      await from(hoBranchId, `/advance-loans/${loanId}/payoff-quote`),
      'the payoff quote leaked the balance of a loan the same caller cannot read',
    ).toBe(false);

    adminApi.withBranch(br2BranchId);
    await assertIntegrity(adminApi, loanId, 'across the branch envelope');
  });

  test('an employee cannot be transferred between branches over the API at all', async () => {
    test.skip(!loanId, 'no subject to attempt a transfer for');

    // Asserted rather than assumed, because "the loan follows a branch transfer"
    // is a case the catalogue asks for and this is the reason it cannot be
    // driven: `branchId` is not on `UpdateEmployeeDto` and `forbidNonWhitelisted`
    // rejects the whole PATCH rather than silently ignoring the field.
    await expect(
      adminApi.patch(`/employees/${emp!.id}`, { branchId: hoBranchId }),
    ).rejects.toThrow();

    const employee = await adminApi.get<{ branchId: string }>(`/employees/${emp!.id}`);
    expect(employee.branchId, 'the refused transfer moved the employee anyway').toBe(br2BranchId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Payroll comes and goes; the loan's history does not
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deleting a draft payroll must release the instalments it claimed and destroy
 * nothing else.
 *
 * The design that makes this true is stated on the schema: payroll GENERATION
 * never writes to `LoanSchedule` — status and paid* are a projection computed at
 * LOCK time — and `AdvanceLoanDeduction.payrollItemId` is `SetNull` rather than
 * `Cascade`, so `payrolls.remove()` has to delete the PENDING and SKIPPED rows
 * EXPLICITLY while leaving PAID and REVERSED ones alone. Both halves are load
 * bearing: forget the explicit delete and a deleted draft holds instalments
 * hostage forever; make it a cascade and unlocking a run erases the history that
 * explains the restatement.
 *
 * The run is narrowed to one employee in E2E-BR2 on purpose. A branch-wide run
 * attaches a PENDING deduction to every live loan in the branch, and every one
 * of those loans then refuses every operation until the run is locked or
 * deleted — including loans belonging to specs running in other workers.
 */
test.describe('a deleted payroll releases its instalments and keeps the history', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  /** Far enough ahead that no other spec's run collides with it. */
  const PERIOD = { month: 11, year: 2032 };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'payroll' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 600,
        installments: 6,
        note: 'payroll delete',
      });
      await clearPayrolls(adminApi, branchId, PERIOD.month, PERIOD.year);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      await clearPayrolls(adminApi, branchId, PERIOD.month, PERIOD.year).catch(() => undefined);
      await sweep(adminApi);
    }
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'generating and deleting a payroll is an ADMIN act');
  });

  test('the schedule and the ledger survive a payroll that was generated and thrown away', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const scheduleBefore = JSON.stringify(await scheduleOf(adminApi, loanId));
    const txnsBefore = JSON.stringify(await txnsOf(adminApi, emp!.id, loanId));
    const loanBefore = await factsOf(adminApi, loanId);

    const run = await runPayroll(adminApi, {
      ...PERIOD,
      branchId,
      employeeIds: [emp!.id],
    });

    // The claim only means something if the run actually claimed an instalment.
    // It is a skip rather than a failure because "this employee produced no
    // payslip" is a payroll-side answer (no salary structure, an excluded
    // status) and diagnosing it here would be diagnosing the wrong module.
    const pending = (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'PENDING');
    if (pending.length === 0) {
      await deletePayroll(adminApi, run.id).catch(() => undefined);
      test.skip(true, 'the run produced no loan deduction for this employee — nothing to release');
    }

    // Generation writes the ledger, never the plan. A schedule row moving here
    // would mean a draft run had already restated the loan.
    expect(
      JSON.stringify(await scheduleOf(adminApi, loanId)),
      'generating a payroll rewrote the repayment plan',
    ).toBe(scheduleBefore);
    expect(
      (await factsOf(adminApi, loanId)).amountRepaid,
      'a DRAFT run moved the balance before anybody locked it',
    ).toBeCloseTo(loanBefore.amountRepaid, 2);
    await assertSplitsSum(adminApi, loanId, 'after payroll generation');

    await deletePayroll(adminApi, run.id);

    // The PENDING rows go — that is what re-releases the instalment to the next
    // run — and everything that is HISTORY stays.
    await expect
      .poll(
        async () => (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'PENDING').length,
        { timeout: 15_000 },
      )
      .toBe(0);
    expect(
      JSON.stringify(await scheduleOf(adminApi, loanId)),
      'deleting the payroll took schedule rows with it',
    ).toBe(scheduleBefore);
    expect(
      JSON.stringify(await txnsOf(adminApi, emp!.id, loanId)),
      'deleting the payroll took money events with it',
    ).toBe(txnsBefore);
    expect(await factsOf(adminApi, loanId), 'deleting the payroll restated the loan')
      .toEqual(loanBefore);
    await assertIntegrity(adminApi, loanId, 'after the payroll was deleted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Re-planning: two regenerations, nothing destroyed
// ───────────────────────────────────────────────────────────────────────────

/**
 * The supersession chain.
 *
 * `LoanScheduleService.regenerate` marks the live SCHEDULED/DEFERRED rows
 * `CANCELLED` with a `supersededAt` and bumps `AdvanceLoanRequest.scheduleVersion`
 * — "retained, not deleted … that IS the audit trail". The retained rows are
 * deliberately NOT returned by any route (`listLive` filters on the current
 * version), so what a spec can observe over HTTP is the OTHER side of the same
 * coin, and it is the side that would break first:
 *
 *   • the version increments once per regeneration and never skips;
 *   • the live rows all carry the new version — asserted as "the row count and
 *     the numbering changed", since a stale row surviving into a new version is
 *     precisely what `@@unique([requestId, version, installmentNo])` exists to
 *     make impossible;
 *   • no installmentNo appears twice within a version, which is that unique
 *     index observed from outside;
 *   • and the money is unchanged by re-planning — a regeneration moves dates and
 *     instalment sizes, never the balance.
 */
test.describe('re-planning a loan twice destroys nothing and duplicates nothing', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'replan' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 600,
        installments: 6,
        note: 'supersession chain',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'prepayment and instalment skips are an ADMIN surface');
  });

  test('the version increments on each re-plan and no instalment number is ever repeated', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const noDuplicates = async (when: string): Promise<void> => {
      const rows = await scheduleOf(adminApi, loanId);
      const numbers = rows.map((r) => r.installmentNo);
      expect(
        new Set(numbers).size,
        `${when}: the live schedule has ${numbers.length} rows but only ` +
          `${new Set(numbers).size} distinct instalment numbers — ` +
          '@@unique([requestId, version, installmentNo]) should have made that impossible',
      ).toBe(numbers.length);
    };

    const v0 = await factsOf(adminApi, loanId);
    expect(v0.scheduleVersion, 'the importer writes version 1').toBe(1);
    const rows0 = await scheduleOf(adminApi, loanId);
    expect(rows0.length).toBe(6);
    await noDuplicates('as imported');
    await assertIntegrity(adminApi, loanId, 'as imported');

    // ── Re-plan 1: a prepayment that shortens the tenure ────────────────────
    // REDUCE_TENURE keeps the instalment and drops rows off the tail, so the
    // shape of the plan changes as well as its version — which is what makes
    // "the old rows are gone from the live view" a real observation rather than
    // a no-op.
    await adminApi.post(`/advance-loans/${loanId}/prepay`, {
      amount: 200,
      mode: 'BANK',
      reference: `${MARK}-utr`,
      recalc: 'REDUCE_TENURE',
    });

    const v1 = await factsOf(adminApi, loanId);
    expect(v1.scheduleVersion, 'the prepayment did not re-plan the loan').toBe(2);
    const rows1 = await scheduleOf(adminApi, loanId);
    expect(rows1.length, 'REDUCE_TENURE left the tail in place').toBeLessThan(rows0.length);
    await noDuplicates('after the prepayment');
    await assertIntegrity(adminApi, loanId, 'after the prepayment');

    // ── Re-plan 2: an instalment pushed out, which re-amortizes ─────────────
    // EXTEND rather than FORGIVE deliberately: FORGIVE writes the row and stops,
    // while EXTEND goes back through the engine — under a reducing balance an
    // extra period accrues extra interest, so it cannot be a date shift.
    const first = rows1[0].installmentNo;
    await adminApi.post(`/advance-loans/${loanId}/skip-installment`, {
      installmentNo: first,
      mode: 'EXTEND',
      reason: `${MARK} instalment deferred for the re-plan journey`,
    });

    const v2 = await factsOf(adminApi, loanId);
    expect(v2.scheduleVersion, 'the skip did not re-plan the loan').toBe(3);
    await noDuplicates('after the skip');
    await assertIntegrity(adminApi, loanId, 'after the skip');

    // Re-planning moves dates and instalment sizes. It must never move money:
    // the balance after two regenerations is the balance the prepayment left.
    expect(
      v2.amountRepaid,
      're-planning the schedule moved what had been repaid',
    ).toBeCloseTo(v1.amountRepaid, 2);
    expect(v2.waivedAmount, 'an EXTEND forgave principal — that is FORGIVE\'s job')
      .toBeCloseTo(v1.waivedAmount, 2);
    expect(v2.amount, 'the original principal was rewritten by a re-plan').toBeCloseTo(v0.amount, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The ledger only ever grows
// ───────────────────────────────────────────────────────────────────────────

/**
 * `LoanTransaction` is append-only, and that is a design decision with a visible
 * consequence: `LoanTransactionStatus.REVERSED` is never written to any row. A
 * reversal INSERTS a `REVERSAL` and leaves the original `POSTED` — which is why
 * the gap report lists that enum member as unreachable. A future "tidy up" that
 * flipped the original's status would look harmless and would destroy the one
 * property this table has.
 *
 * Every assertion here compares the ORDERED PREFIX of the transaction stream
 * before and after, which is the strongest statement available over a route that
 * returns no row ids: if any earlier row had been edited, the prefix would
 * differ; if any had been deleted, it would be shorter.
 */
test.describe('the money ledger is append-only', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'ledger' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 500,
        installments: 5,
        note: 'append-only ledger',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'write-off and reinstatement are ADMIN-only operations');
  });

  test('a reversal adds a row and does not touch the one it reverses', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // The importer writes a DISBURSEMENT, so the stream is never empty and the
    // prefix comparison below has something to be a prefix OF.
    const opening = await txnsOf(adminApi, emp!.id, loanId);
    expect(opening.length, 'the import wrote no money events at all').toBeGreaterThan(0);

    await adminApi.post(`/advance-loans/${loanId}/write-off`, {
      reason: `${MARK} written off so the reversal has something to reverse`,
    });
    await assertIntegrity(adminApi, loanId, 'after the write-off');

    const afterWriteOff = await txnsOf(adminApi, emp!.id, loanId);
    expect(
      afterWriteOff.slice(0, opening.length),
      'the write-off edited an existing ledger row',
    ).toEqual(opening);
    const written = afterWriteOff[afterWriteOff.length - 1];
    expect(written.type).toBe('WRITE_OFF');
    expect(written.status, 'a freshly posted transaction is not POSTED').toBe('POSTED');

    // Reinstating is the reversal. It restores the balance by INSERTING, which
    // is the property under test.
    await adminApi.post(`/advance-loans/${loanId}/reinstate`, {
      reason: `${MARK} employee returned and agreed a repayment plan`,
    });
    await assertIntegrity(adminApi, loanId, 'after the reinstatement');

    const afterReinstate = await txnsOf(adminApi, emp!.id, loanId);
    expect(
      afterReinstate.length,
      'the reversal did not append a row',
    ).toBe(afterWriteOff.length + 1);
    // The whole earlier stream, field for field. This is the assertion: not that
    // the write-off row still exists, but that not one of its columns moved.
    expect(
      afterReinstate.slice(0, afterWriteOff.length),
      'the reversal mutated the transaction it reverses',
    ).toEqual(afterWriteOff);

    const reversal = afterReinstate[afterReinstate.length - 1];
    expect(reversal.type).toBe('REVERSAL');
    expect(reversal.amount, 'the reversal is not for the amount it reverses')
      .toBeCloseTo(written.amount, 2);
    // The original stays POSTED — `LoanTransactionStatus.REVERSED` is written by
    // nothing, which is the append-only design and not an oversight.
    expect(
      afterReinstate[afterWriteOff.length - 1].status,
      'the original was flipped to REVERSED — the ledger stopped being append-only',
    ).toBe('POSTED');
  });

  test('a replayed prepayment is refused by its idempotency key and posts nothing', async () => {
    test.skip(!loanId, 'no loan to pay against');

    // A real v4 UUID: `PrepayLoanDto.idempotencyKey` is `@IsUUID()`, so a
    // decorative string is a 400 for the wrong reason and the retry below would
    // prove nothing.
    const key = uuidV4();

    const before = await txnsOf(adminApi, emp!.id, loanId);
    await adminApi.post(`/advance-loans/${loanId}/prepay`, {
      amount: 100,
      mode: 'BANK',
      idempotencyKey: key,
    });
    const afterFirst = await txnsOf(adminApi, emp!.id, loanId);
    expect(afterFirst.length, 'the prepayment posted no transaction').toBe(before.length + 1);
    await assertIntegrity(adminApi, loanId, 'after the first prepayment');

    // The retry. The unique index on `loan_transactions.idempotency_key` is the
    // real protection; the pre-check turns it into a readable 409 instead of a
    // constraint violation surfacing as a 500.
    await expect(
      adminApi.post(`/advance-loans/${loanId}/prepay`, {
        amount: 100,
        mode: 'BANK',
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/already been recorded/i);

    expect(
      await txnsOf(adminApi, emp!.id, loanId),
      'the replayed payment posted a second time',
    ).toEqual(afterFirst);
    await assertIntegrity(adminApi, loanId, 'after the replayed prepayment');
  });
});

/**
 * The payroll half of the same property, which needs a run to be locked.
 *
 * Locking is what flips PENDING deductions to PAID, moves `amountRepaid`, and
 * mirrors each recovery into `LoanTransaction` with `deductionId` set — a UNIQUE
 * column, so one deduction can be mirrored at most once. Unlocking then REVERSES
 * append-only: the deduction becomes `REVERSED` (never deleted) and a `REVERSAL`
 * transaction is written.
 *
 * Both directions are asserted against the split invariant, because these are
 * the only rows in the system whose split is computed by the recovery planner
 * rather than copied from a schedule row.
 */
test.describe('locking and unlocking a payroll leaves an append-only trail', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let payrollId = '';
  let setupError = '';

  const PERIOD = { month: 10, year: 2032 };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'lock' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 600,
        installments: 6,
        note: 'lock and unlock',
      });
      await clearPayrolls(adminApi, branchId, PERIOD.month, PERIOD.year);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      await clearPayrolls(adminApi, branchId, PERIOD.month, PERIOD.year).catch(() => undefined);
      await sweep(adminApi);
    }
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'locking and unlocking a payroll is an ADMIN act');
  });

  test('a recovery is mirrored once, and its reversal is written rather than erased', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const run = await runPayroll(adminApi, { ...PERIOD, branchId, employeeIds: [emp!.id] });
    payrollId = run.id;

    const pending = (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'PENDING');
    if (pending.length === 0) {
      await deletePayroll(adminApi, payrollId).catch(() => undefined);
      test.skip(true, 'the run recovered nothing for this employee — nothing to lock');
    }
    await assertSplitsSum(adminApi, loanId, 'on the PENDING rows a draft run wrote');

    // DRAFT → PENDING_APPROVAL → APPROVED → LOCKED. `lockPayroll` refuses
    // anything else, and the intermediate steps have no helper because they are
    // payroll's own workflow rather than a loan concern.
    await adminApi.post(`/payrolls/${payrollId}/submit`, {});
    await adminApi.post(`/payrolls/${payrollId}/approve`, {});
    await lockPayroll(adminApi, payrollId);

    await expect
      .poll(
        async () => (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'PAID').length,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const paid = (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'PAID');
    await assertIntegrity(adminApi, loanId, 'after the payroll was locked');

    // One mirror per recovery, no more: `LoanTransaction.deductionId` is UNIQUE
    // precisely so a re-run cannot post the same recovery into the money ledger
    // twice, and `createMany({ skipDuplicates: true })` is what leans on it.
    const afterLock = await txnsOf(adminApi, emp!.id, loanId);
    const recoveries = afterLock.filter((t) => t.type === 'EMI_RECOVERY');
    expect(
      recoveries.length,
      `${paid.length} deduction(s) were recovered but ${recoveries.length} EMI_RECOVERY ` +
        'transactions exist — a deduction was mirrored more than once',
    ).toBe(paid.filter((d) => d.amount > 0).length);

    // ── Unlock: reverse without erasing ────────────────────────────────────
    await unlockPayroll(
      adminApi,
      payrollId,
      `${MARK} restating the run for the data-integrity journey`,
    );

    await expect
      .poll(
        async () =>
          (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'REVERSED').length,
        { timeout: 15_000 },
      )
      .toBe(paid.length);

    // The reversed rows are still THERE — a payslip restatement has to remain
    // explainable, which it cannot be if the row it restates was deleted.
    const reversed = (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'REVERSED');
    expect(reversed.map((r) => r.id).sort()).toEqual(paid.map((r) => r.id).sort());
    await assertIntegrity(adminApi, loanId, 'after the payroll was unlocked');

    const afterUnlock = await txnsOf(adminApi, emp!.id, loanId);
    expect(
      afterUnlock.slice(0, afterLock.length),
      'the unlock rewrote the recovery it was reversing',
    ).toEqual(afterLock);
    expect(
      afterUnlock.filter((t) => t.type === 'REVERSAL').length,
      'the unlock reversed the money without writing a REVERSAL row',
    ).toBe(paid.length);

    await deletePayroll(adminApi, payrollId);
    payrollId = '';

    // And deleting the now-unlocked run leaves the REVERSED history behind —
    // `payrollItemId` is SetNull, and `remove()` only deletes PENDING/SKIPPED.
    await expect
      .poll(
        async () =>
          (await ledgerRows(adminApi, loanId)).filter((d) => d.status === 'REVERSED').length,
        { timeout: 15_000 },
      )
      .toBe(paid.length);
    await assertIntegrity(adminApi, loanId, 'after the reversed run was deleted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Conversion: two loans, one receivable
// ───────────────────────────────────────────────────────────────────────────

/**
 * Converting an advance to a loan creates a NEW request rather than editing the
 * old one, so the history already recovered stays attached to the terms it was
 * recovered under.
 *
 * That only holds together if the pair is LINKED and the pair NETS TO ZERO: a
 * CONVERSION credit on the advance for exactly what was outstanding, a CONVERSION
 * debit on the new loan for exactly the same figure. Without the link the old
 * balance is simply gone from every report; without the netting the company's
 * receivable ledger counts the same money twice.
 */
test.describe('a conversion links the pair and their transactions net to zero', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let advanceId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'convert' });
      advanceId = await importLoan(adminApi, {
        code: emp.code,
        principal: 240,
        installments: 1,
        type: 'ADVANCE',
        note: 'conversion linkage',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'conversion is an ADMIN/HR operation');
  });

  test('convertedFromId points back, and the two CONVERSION rows cancel out', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const before = await factsOf(adminApi, advanceId);
    const outstanding =
      before.amount - before.amountRepaid - before.writtenOffAmount - before.waivedAmount;
    expect(outstanding, 'the advance has nothing left to convert').toBeGreaterThan(0);

    await adminApi.post(`/advance-loans/${advanceId}/convert`, {
      installments: 4,
      reason: `${MARK} spread the advance over four cycles`,
    });

    const closed = await factsOf(adminApi, advanceId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closureType).toBe('CONVERTED');

    // The new request is found through the LINK, not through a name match: the
    // link is the thing being tested, and searching by reason would pass even if
    // `convertedFromId` were never written.
    const loans = await statementOf(adminApi, emp!.id);
    const spawnedIds: string[] = [];
    for (const l of loans) {
      if (l.id === advanceId) continue;
      const facts = await factsOf(adminApi, l.id);
      if (facts.convertedFromId === advanceId) spawnedIds.push(l.id);
    }
    expect(spawnedIds.length, 'conversion closed the advance without linking the loan it created')
      .toBe(1);

    const spawned = await factsOf(adminApi, spawnedIds[0]);
    expect(spawned.type).toBe('LOAN');
    // A conversion re-enters approval: new terms need a fresh decision rather
    // than taking effect because an administrator typed a number.
    expect(spawned.status, 'the converted loan took effect without a decision').toBe('PENDING');
    expect(spawned.amount).toBeCloseTo(outstanding, 2);

    // The netting. Both rows are stored POSITIVE — direction is implied by type
    // and narration — so "nets to zero" is asserted as equal-and-opposite:
    // exactly one credit on the old, exactly one debit on the new, same figure.
    const oldTxns = (await txnsOf(adminApi, emp!.id, advanceId)).filter(
      (t) => t.type === 'CONVERSION',
    );
    const newTxns = (await txnsOf(adminApi, emp!.id, spawned.id)).filter(
      (t) => t.type === 'CONVERSION',
    );
    expect(oldTxns.length, 'the closed advance carries no conversion entry').toBe(1);
    expect(newTxns.length, 'the new loan carries no conversion entry').toBe(1);
    expect(
      oldTxns[0].amount - newTxns[0].amount,
      `the conversion pair does not net to zero: ${oldTxns[0].amount} out, ${newTxns[0].amount} in`,
    ).toBeCloseTo(0, 2);
    expect(oldTxns[0].amount).toBeCloseTo(outstanding, 2);

    await assertIntegrity(adminApi, advanceId, 'on the converted advance');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Settlement: the snapshot is the undo
// ───────────────────────────────────────────────────────────────────────────

/**
 * An exit settlement records a DECISION and its ledger effect, and stores the
 * pre-state of every loan it touched in `LoanSettlement.decisionsJson` so
 * `reverseSettlement` can "restore exactly rather than guessing".
 *
 * `decisionsJson` is not readable over HTTP — there is no GET for a settlement —
 * so the snapshot is asserted the only way it can be, and arguably the only way
 * that matters: capture the loan field-for-field before the settlement, reverse
 * it, and demand the same record back. A snapshot that recorded the wrong fields
 * would restore the wrong ones, and that is what this catches.
 */
test.describe('a settlement can be undone exactly', () => {
  let adminApi: ApiClient;
  let branchId = '';
  let emp: TestEmployee | null = null;
  let loanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'E2E-BR2');
      adminApi.withBranch(branchId);
      emp = await subject(adminApi, { branchId, suffix: 'settle' });
      loanId = await importLoan(adminApi, {
        code: emp.code,
        principal: 450,
        installments: 3,
        note: 'settlement snapshot',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) await sweep(adminApi);
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'settlement and its reversal are ADMIN routes');
  });

  test('reversing a settlement restores the loan field for field', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const before = await factsOf(adminApi, loanId);
    const txnsBefore = await txnsOf(adminApi, emp!.id, loanId);
    await assertIntegrity(adminApi, loanId, 'before the settlement');

    // Every outstanding loan must be named — a silent omission is how a
    // receivable disappears at exit, so the request is refused otherwise. The
    // quote is what says which those are.
    const quote = await adminApi.get<{
      loans: Array<{ loanId: string; total: number }>;
      totalOutstanding: number;
    }>(`/advance-loans/settlement/${emp!.id}`);
    expect(quote.loans.map((l) => l.loanId), 'the settlement quote missed the loan')
      .toContain(loanId);

    const decided = await adminApi.post<{ settlementId: string }>(
      `/advance-loans/settlement/${emp!.id}`,
      {
        decisions: quote.loans.map((l) => ({
          loanId: l.loanId,
          action: 'WAIVE',
          amount: l.total,
          reason: `${MARK} waived at exit for the settlement journey`,
        })),
        reason: `${MARK} exit settlement`,
      },
    );
    expect(decided.settlementId, 'the settlement recorded no id to reverse').toBeTruthy();

    const settled = await factsOf(adminApi, loanId);
    expect(settled, 'the settlement changed nothing at all').not.toEqual(before);
    await assertIntegrity(adminApi, loanId, 'after the settlement');

    await adminApi.post(`/advance-loans/settlement/${decided.settlementId}/reverse`, {
      reason: `${MARK} settlement raised in error and reversed`,
    });

    // The claim. Not "roughly where it was" — the same record.
    const restored = await factsOf(adminApi, loanId);
    expect(restored, 'the reversal did not restore the pre-settlement state exactly')
      .toEqual(before);
    await assertIntegrity(adminApi, loanId, 'after the settlement was reversed');

    // And it restored by APPENDING: the reversal writes its own REVERSAL row
    // rather than deleting the WAIVER the settlement posted.
    const txnsAfter = await txnsOf(adminApi, emp!.id, loanId);
    expect(
      txnsAfter.length,
      'the settlement reversal deleted ledger rows instead of adding one',
    ).toBeGreaterThan(txnsBefore.length);
    expect(
      txnsAfter.slice(0, txnsBefore.length),
      'the settlement reversal edited history',
    ).toEqual(txnsBefore);
    expect(txnsAfter[txnsAfter.length - 1].type).toBe('REVERSAL');

    // A settlement is reversible ONCE. Asserting the refusal is what keeps the
    // pre-state snapshot from being replayed onto a loan that has since moved.
    await expect(
      adminApi.post(`/advance-loans/settlement/${decided.settlementId}/reverse`, {
        reason: `${MARK} attempting to reverse the same settlement twice`,
      }),
    ).rejects.toThrow(/already been reversed/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The shapes nobody designed for
// ───────────────────────────────────────────────────────────────────────────

/**
 * A loan with no plan and no ledger has to render, not throw.
 *
 * The detail route loads three things — the loan, its schedule and its payoff
 * quote — and a request that never reached approval legitimately has neither of
 * the last two. The page handles that with two DIFFERENT empty states, and the
 * difference is the point: "nothing was ever recovered because this never
 * reached payroll" and "nothing has been recovered yet" are opposite facts about
 * the company's money, and `data-never-disbursed` is what separates them.
 *
 * A blank screen here is the failure mode the whole `problems` fixture exists
 * for, so these two cases are worth a browser even though everything else in
 * this file is not.
 */
test.describe('a loan with no schedule and no ledger still draws a page', () => {
  let adminApi: ApiClient;
  let employeeApi: ApiClient;
  let hoBranchId = '';
  let br2BranchId = '';
  let emp: TestEmployee | null = null;
  let pendingId = '';
  let importedId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      employeeApi = await ApiClient.as('employee');
      hoBranchId = await branchIdByCode(adminApi, 'HO');
      br2BranchId = await branchIdByCode(adminApi, 'E2E-BR2');

      // The only way to a PENDING request: file it as somebody who can. An
      // API-created employee has no usable login, and ADMIN is deliberately not
      // on `POST /advance-loans` — administrators administer, they do not submit.
      await ensureAllowance(employeeApi, adminApi, 300, MARKER_PREFIX);
      const created = await employeeApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 300,
        installments: 3,
        reason: `${MARK} — a request that never reached approval`,
      });
      pendingId = created.id;

      adminApi.withBranch(br2BranchId);
      emp = await subject(adminApi, { branchId: br2BranchId, suffix: 'orphan' });
      importedId = await importLoan(adminApi, {
        code: emp.code,
        principal: 360,
        installments: 3,
        note: 'debt with no recovery yet',
      });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('admin')) {
      if (pendingId) await retire(pendingId, employeeApi, adminApi).catch(() => undefined);
      if (adminApi) await sweep(adminApi);
    }
    await employeeApi?.dispose();
    await adminApi?.dispose();
  });

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the detail route is only reachable for the loan book owner');
  });

  test('a request that never reached approval says so in both empty states', async ({
    page,
    problems,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await selectBranch(page, hoBranchId);
    const detail = new LoanLifecyclePage(page);
    await detail.open(pendingId);
    await detail.expectStatus('PENDING');

    // No plan and no ledger, and neither is an error — the page must draw the
    // request rather than fail on the two things it does not have.
    expect(await detail.scheduleIsEmpty(), 'a request with no schedule drew schedule rows')
      .toBe(true);
    expect(await detail.ledgerIsEmpty()).toBe(true);
    expect(
      await detail.ledgerNeverDisbursed(),
      'a request that never became debt is described as "nothing recovered YET"',
    ).toBe(true);

    // The summary tiles change shape too: showing "Outstanding 300" on a request
    // nobody approved would be money the company is not owed.
    expect(await detail.summary('principal')).toBeCloseTo(300, 2);
    expect(await detail.summary('outstanding'), 'an unapproved request reported a balance')
      .toBeNull();

    settle(problems, 'the detail page of a request with no schedule');
  });

  test('a live loan with no recovery yet uses the other empty state', async ({
    page,
    problems,
  }) => {
    test.skip(!importedId, 'no imported loan to open');

    await selectBranch(page, br2BranchId);
    const detail = new LoanLifecyclePage(page);
    await detail.open(importedId);
    await detail.expectStatus('ACTIVE');

    // The other side of the same pair. This loan IS debt — it has a plan and a
    // balance — and payroll simply has not reached it, which is a completely
    // different sentence from the one above.
    expect(await detail.scheduleIsEmpty(), 'an approved loan has no repayment plan').toBe(false);
    await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(3);
    expect(await detail.ledgerIsEmpty()).toBe(true);
    expect(
      await detail.ledgerNeverDisbursed(),
      'a disbursed loan is described as never having reached payroll',
    ).toBe(false);

    const quote = await quoteOf(adminApi.withBranch(br2BranchId), importedId);
    await expect
      .poll(() => detail.summary('outstanding'), { timeout: 15_000 })
      .toBeCloseTo(quote.outstandingPrincipal, 2);

    settle(problems, 'the detail page of a loan payroll has not reached');
  });
});
