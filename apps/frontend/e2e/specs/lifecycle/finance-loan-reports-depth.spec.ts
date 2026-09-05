import { request } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, settle, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import {
  LOAN_REPORT_TABS,
  LoanReportTab,
  LoanReportsPage,
  parseCsvLine,
  selectBranch,
} from '../../pages/loan-reports';
import {
  branchIdByCode,
  clearPayrolls,
  deductionsFor,
  flagFlipAllowed,
  liveLoan,
  lockPayroll,
  makeEmployee,
  marker,
  retireAllMarked,
  runPayroll,
  scheduleOf,
  TestEmployee,
  terminateEmployee,
  withSettings,
} from '../../loan-support';

/**
 * The loan book, checked against data whose answer is already known.
 *
 * `finance-loan-reports.spec.ts` is the screen's file: five tabs, per-tab
 * columns, empty states, Export enabled or not, Back, and who is refused. Every
 * one of its assertions holds whatever the loan book happens to contain, which
 * is exactly what makes it safe to run against a shared database — and exactly
 * what makes it unable to catch a report that is quietly the WRONG NUMBER.
 *
 * This file is the other half. It builds a book whose every figure is arithmetic
 * the spec can do itself, and it exercises the query parameters the screen never
 * sends. Three claims run through it:
 *
 *   1. **A report is only as good as its arithmetic.** `outstanding` is
 *      `principal − repaid − writtenOff − waived`, recomputed from PAID ledger
 *      rows rather than from the denormalised `amountRepaid` column. Six loans
 *      in six different states are built, and each employee's row is asserted to
 *      the cent. Branch totals are never asserted — they belong to whoever else
 *      is using the database.
 *   2. **The filters are API-only.** `asOf`, `departmentId`, `type`,
 *      `loanTypeId`, `page`/`limit`, `month`/`year`, `includeHeld`, `from`/`to`
 *      have no control on the screen at all (`app/dashboard/advance-loans/
 *      reports/page.tsx` sends `limit: 100` and nothing else). An untested query
 *      parameter is an untested SQL branch, and three of these are spliced into
 *      raw SQL.
 *   3. **LOCKED is the basis, and in-flight is reported separately.** A payroll
 *      run that is generated but not locked must not move `outstanding` by a
 *      cent; it must show up under `inFlight` and in `meta.openPayrolls`. That
 *      is asserted by staging the run rather than by projecting it — which the
 *      screen's own file explicitly cannot do, because it has no private branch
 *      to run payroll in.
 *
 * ## How the fixture is built, and why it is the importer
 *
 * `POST /advance-loans/import/confirm` takes the rows a preview produced, as
 * JSON, and creates loans that are already mid-life: a disbursement date, a
 * first deduction MONTH, instalments already paid, and a status. It is the only
 * path in the product that can produce a loan whose instalment fell due four
 * months ago — the normal flow snaps the first due date to the end of the month
 * the loan was approved in, so a natively created loan is never overdue on the
 * day it is created, and the ageing buckets could not be tested at all.
 *
 * It also writes the PAID ledger rows for the consumed instalments, which is
 * what `outstanding`'s `asOf` and `interest-earned` read. So the fixture is not
 * a shortcut around the product's arithmetic — it goes through the same
 * amortization engine the approval path uses.
 *
 * Every borrower is made by `makeEmployee`, in `E2E-BR2` and in departments that
 * hold no seeded staff, so the figures are this file's own. `makeEmployee`
 * cannot hand back a session (see its `NO_LOGIN`), which costs nothing here: an
 * ADMIN files, approves, writes off and reports on all of it.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half of the marker — what identifies a record as this file's. */
const MARKER_PREFIX = 'pw-loanrpt-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const RUN = marker(MARKER_PREFIX);

// ───────────────────────────────────────────────────────────────────────────
// The shapes the five endpoints answer with
// ───────────────────────────────────────────────────────────────────────────

interface ReportMeta {
  asOf: string;
  basis: string;
  openPayrolls: Array<{ id: string; month: number; year: number; status?: string }>;
  note?: string;
  month?: number;
  year?: number;
}

interface ReportEnvelope<T> {
  success?: boolean;
  data: T[];
  totals?: Record<string, number>;
  buckets?: Record<string, { count: number; amount: number }>;
  meta: ReportMeta;
}

interface OutstandingRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  loans: number;
  principal: number;
  repaid: number;
  writtenOff: number;
  waived: number;
  outstanding: number;
  inFlight: number;
}

interface EmiDueRow {
  scheduleId: string;
  loanId: string;
  referenceNo: string | null;
  type: string;
  employeeId: string;
  installmentNo: number;
  dueDate: string;
  emiAmount: number;
  status: string;
}

interface OverdueRow {
  scheduleId: string;
  loanId: string;
  installmentNo: number;
  dueDate: string;
  overdueDays: number;
  bucket: string;
  amountDue: number;
}

interface PortfolioRow {
  status: string;
  type: string;
  count: number;
  principal: number;
  outstanding: number;
}

interface InterestRow {
  year: number;
  month: number;
  interest: number;
  principal: number;
  fee: number;
}

interface StatementLoan {
  id: string;
  status: string;
  type: string;
  amount: number;
  outstanding: number;
}

/**
 * A report, read WITH its envelope.
 *
 * Every loan-report route answers with its own `{ success, data, totals?,
 * buckets?, meta }` and nothing wraps it again — there is no global response
 * interceptor (`app.module.ts` registers only the branch and audit ones), which
 * is why `services/loanReportService.ts` types the axios body as exactly that
 * envelope. `ApiClient.get` unwraps one `{ success, data }`, so it hands back
 * the ROWS and silently drops `totals`, `buckets` and `meta` — three of the
 * four things this file asserts. Read raw, and keep the whole answer.
 *
 * The token and `X-Branch-Id` are the client's own: the outstanding report is
 * branch-scoped in SQL (`rawBranchFilter('e')`), so reading it without the
 * header a client would have sent would be reading a different book.
 */
let reportCtx: APIRequestContext | null = null;

/** `ApiClient.withBranch` keeps the id private, so the raw reader is told too. */
const branchOfClient = new WeakMap<ApiClient, string>();

const scopeTo = (api: ApiClient, branch: string): ApiClient => {
  branchOfClient.set(api, branch);
  return api.withBranch(branch);
};

async function report<T>(api: ApiClient, path: string): Promise<ReportEnvelope<T>> {
  if (!reportCtx) reportCtx = await request.newContext({ baseURL: API_URL });
  const headers: Record<string, string> = { Authorization: `Bearer ${api.token}` };
  const branch = branchOfClient.get(api);
  if (branch) headers['X-Branch-Id'] = branch;

  const res = await reportCtx.get(path, { headers });
  const text = await res.text();
  // Same sentence `ApiClient` throws, because the refusal cases below match on
  // it: `rejects.toThrow(/failed: (400|500)/)` and the my-statement message.
  if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()} ${text}`);
  return JSON.parse(text) as ReportEnvelope<T>;
}

// ───────────────────────────────────────────────────────────────────────────
// Cycles and dates
// ───────────────────────────────────────────────────────────────────────────

interface Cycle {
  month: number;
  year: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The cycle `n` months before this one, in UTC — the suite's only clock. */
function cycleBack(n: number): Cycle {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

const period = (c: Cycle) => `${c.year}-${pad2(c.month)}`;
const firstDayOf = (c: Cycle) => `${c.year}-${pad2(c.month)}-01`;

/**
 * The day every monthly instalment of a cycle falls due.
 *
 * `LoanScheduleService.snapToCycle` and the importer both build the first due
 * date as `Date.UTC(year, month, 0)` — the last day of the month — so an ageing
 * assertion can be arithmetic rather than a guess.
 */
const dueDayOf = (c: Cycle) => isoDay(new Date(Date.UTC(c.year, c.month, 0)));

const shiftDays = (isoDate: string, days: number) =>
  isoDay(new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * 86_400_000));

/**
 * A payroll period no other spec will claim.
 *
 * `payroll.spec.ts` picks 1–24 months out and `payroll-depth` picks 30–47; two
 * runs for one branch and month collide with a 409 and the loser fails for a
 * reason that has nothing to do with what it was testing.
 */
const PAYROLL_PERIOD: Cycle = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 50 + (Date.now() % 11));
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
})();

// ───────────────────────────────────────────────────────────────────────────
// The fixture
// ───────────────────────────────────────────────────────────────────────────

/** One row of the importer's spreadsheet, as `confirm` consumes it. */
interface ImportRow {
  employeeCode: string;
  referenceNo: string;
  type: 'ADVANCE' | 'LOAN';
  principal: number;
  interestMethod: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  interestRate: number;
  installments: number;
  emi: number | null;
  disbursedOn: string;
  firstDeductionPeriod: string;
  installmentsPaid: number;
  amountRepaid: number;
  status: string;
  notes: string;
}

interface ImportOutcome {
  results?: Array<{ referenceNo: string; success: boolean; loanId?: string; error?: string }>;
}

/**
 * Creates the rows and returns their loan ids by reference.
 *
 * `confirm` reports per row rather than throwing, so a partial import would
 * otherwise leave the file asserting against a book that is missing a loan and
 * blaming the report for it.
 */
async function importLoans(admin: ApiClient, rows: ImportRow[]): Promise<Record<string, string>> {
  // One row in the known set carries FLAT interest on purpose — the reports
  // have to have some interest to earn. The importer refuses any non-NONE
  // method while `loan_interest_enabled` is off (the e2e baseline), so the
  // fixture is built with the switch briefly on. `withSettings` restores it in
  // a `finally`, and only this import sits inside the window.
  const carriesInterest = rows.some((r) => (r.interestMethod ?? 'NONE') !== 'NONE');
  if (carriesInterest && !flagFlipAllowed()) {
    throw new Error(
      'the known loan set includes an interest-bearing loan, and the importer refuses ' +
        "those while loan_interest_enabled is 'false'. Re-run with E2E_ALLOW_FLAG_FLIP=1.",
    );
  }
  const outcome = carriesInterest
    ? await withSettings(admin, { loan_interest_enabled: 'true' }, () =>
        admin.post<ImportOutcome>('/advance-loans/import/confirm', { rows }),
      )
    : await admin.post<ImportOutcome>('/advance-loans/import/confirm', { rows });
  const byReference: Record<string, string> = {};
  for (const result of outcome?.results ?? []) {
    if (!result.success || !result.loanId) {
      throw new Error(`import of ${result.referenceNo} failed: ${result.error ?? 'no loan id'}`);
    }
    byReference[result.referenceNo] = result.loanId;
  }
  if (Object.keys(byReference).length !== rows.length) {
    throw new Error(
      `imported ${Object.keys(byReference).length} of ${rows.length} loans — the fixture is incomplete`,
    );
  }
  return byReference;
}

/** Every figure in the known set, so an assertion reads as arithmetic. */
const AMOUNTS = {
  partRepaid: 6000,
  partRepaidPaid: 2000,
  advance: 900,
  completed: 3000,
  writtenOff: 2000,
  held: 1200,
  aged: 500,
  payroll: 4800,
  leaver: 1500,
  leaverPaid: 500,
  closedUnpaid: 700,
} as const;

/** FLAT 12% on 6000 over six monthly instalments: 6000 × 12% × 0.5 = 360. */
const PART_REPAID_INTEREST_PER_INSTALMENT = 60;

let adminApi: ApiClient;
/** A second admin session, scoped to the seeded branch the role accounts live in. */
let adminHoApi: ApiClient;
let managerApi: ApiClient;

let branchId = '';
let hoBranchId = '';
let finDeptId = '';
let opsDeptId = '';
let setupError = '';

let borrower: TestEmployee; // part-repaid loan + an advance
let settler: TestEmployee; // a fully repaid loan + a written-off one
let holder: TestEmployee; // an on-hold loan + one that fell due months ago
let payrollBorrower: TestEmployee; // the only employee a payroll run touches
let leaver: TestEmployee; // terminated mid-file
let closer: TestEmployee; // a CLOSED loan with an unpaid instalment

let loans: Record<string, string> = {};
/** The cycle each fixture loan's instalments start in. */
let firstCycle: Record<string, Cycle> = {};

const ref = (name: string) => `LN-${RUN}-${name}`;

async function departmentIdByCode(api: ApiClient, code: string): Promise<string> {
  const raw = await api.get<Array<{ id: string; code: string }> | { data?: Array<{ id: string; code: string }> }>(
    '/departments',
  );
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  const hit = list.find((d) => d.code === code);
  if (!hit) throw new Error(`No department with code ${code} — run the e2e baseline seed`);
  return hit.id;
}

test.beforeAll(async () => {
  if (!isProject('admin')) return;

  adminApi = await ApiClient.as('admin');
  adminHoApi = await ApiClient.as('admin');
  managerApi = await ApiClient.as('manager');

  try {
    branchId = await branchIdByCode(adminApi, 'E2E-BR2');
    hoBranchId = await branchIdByCode(adminHoApi, 'HO');
    scopeTo(adminApi, branchId);
    scopeTo(adminHoApi, hoBranchId);
    scopeTo(managerApi, hoBranchId);

    finDeptId = await departmentIdByCode(adminApi, 'E2E-FIN');
    opsDeptId = await departmentIdByCode(adminApi, 'E2E-OPS');

    // Three borrowers in the department the seed leaves empty, so the
    // `departmentId` filter and the pagination sweep have a set this file owns.
    const inFinance = { branchId, departmentId: finDeptId };
    const inOps = { branchId, departmentId: opsDeptId };
    borrower = await makeEmployee(adminApi, { marker: `${RUN}a`, ...inFinance });
    settler = await makeEmployee(adminApi, { marker: `${RUN}b`, ...inFinance });
    holder = await makeEmployee(adminApi, { marker: `${RUN}c`, ...inFinance });
    payrollBorrower = await makeEmployee(adminApi, { marker: `${RUN}d`, ...inOps });
    leaver = await makeEmployee(adminApi, { marker: `${RUN}e`, ...inOps });
    closer = await makeEmployee(adminApi, { marker: `${RUN}f`, ...inOps });

    const now = cycleBack(0);
    firstCycle = {
      partRepaid: cycleBack(3),
      advance: now,
      completed: cycleBack(4),
      writtenOff: now,
      held: now,
      aged: cycleBack(5),
      payroll: now,
      leaver: cycleBack(2),
      closedUnpaid: now,
    };

    const row = (over: Partial<ImportRow> & Pick<ImportRow, 'employeeCode' | 'referenceNo'>): ImportRow => ({
      type: 'LOAN',
      principal: 1000,
      interestMethod: 'NONE',
      interestRate: 0,
      installments: 1,
      emi: null,
      disbursedOn: isoDay(new Date()),
      firstDeductionPeriod: period(now),
      installmentsPaid: 0,
      amountRepaid: 0,
      status: 'ACTIVE',
      notes: `${RUN} — report fixture`,
      ...over,
    });

    loans = await importLoans(adminApi, [
      // Live and part repaid: two of six instalments consumed, and the only
      // loan in the set that carries interest.
      row({
        employeeCode: borrower.code,
        referenceNo: ref('part'),
        principal: AMOUNTS.partRepaid,
        interestMethod: 'FLAT',
        interestRate: 12,
        installments: 6,
        firstDeductionPeriod: period(firstCycle.partRepaid),
        disbursedOn: firstDayOf(firstCycle.partRepaid),
        installmentsPaid: 2,
        amountRepaid: AMOUNTS.partRepaidPaid,
      }),
      // An ADVANCE, so the `type` filter has both sides to separate.
      row({
        employeeCode: borrower.code,
        referenceNo: ref('adv'),
        type: 'ADVANCE',
        principal: AMOUNTS.advance,
      }),
      // Repaid in full.
      row({
        employeeCode: settler.code,
        referenceNo: ref('done'),
        principal: AMOUNTS.completed,
        installments: 3,
        firstDeductionPeriod: period(firstCycle.completed),
        disbursedOn: firstDayOf(firstCycle.completed),
        installmentsPaid: 3,
        amountRepaid: AMOUNTS.completed,
        // CLOSED, not COMPLETED. This row used to smuggle a COMPLETED status
        // through `confirm`, which re-derived the schedule but did NOT
        // re-validate its input — `preview` was the only thing checking Status
        // was one of ACTIVE/CLOSED/ON_HOLD. Both now run the same validator, so
        // the only terminal statuses an import can produce are the ones the
        // template documents. CLOSED is the right one here anyway: the loan is
        // fully repaid and off the books, which is what the report must exclude.
        status: 'CLOSED',
      }),
      // Written off in the setup below, so the balance leaves the report while
      // the principal stays in it.
      row({
        employeeCode: settler.code,
        referenceNo: ref('off'),
        principal: AMOUNTS.writtenOff,
        installments: 2,
      }),
      // On hold, with an instalment due in the current cycle.
      row({
        employeeCode: holder.code,
        referenceNo: ref('hold'),
        principal: AMOUNTS.held,
        installments: 2,
        status: 'ON_HOLD',
      }),
      // Due five cycles ago and never paid — the ageing subject.
      row({
        employeeCode: holder.code,
        referenceNo: ref('aged'),
        principal: AMOUNTS.aged,
        firstDeductionPeriod: period(firstCycle.aged),
        disbursedOn: firstDayOf(firstCycle.aged),
      }),
      // The only loan a payroll run is allowed to touch.
      row({
        employeeCode: payrollBorrower.code,
        referenceNo: ref('pay'),
        principal: AMOUNTS.payroll,
        installments: 4,
      }),
      // Owned by someone who leaves the company halfway through this file.
      row({
        employeeCode: leaver.code,
        referenceNo: ref('leaver'),
        principal: AMOUNTS.leaver,
        installments: 3,
        firstDeductionPeriod: period(firstCycle.leaver),
        disbursedOn: firstDayOf(firstCycle.leaver),
        installmentsPaid: 1,
        amountRepaid: AMOUNTS.leaverPaid,
      }),
      // Terminal, but with an unpaid instalment still sitting in this cycle.
      row({
        employeeCode: closer.code,
        referenceNo: ref('closed'),
        principal: AMOUNTS.closedUnpaid,
        status: 'CLOSED',
      }),
    ]);

    await adminApi.post(`/advance-loans/${loans[ref('off')]}/write-off`, {
      reason: `${RUN} — uncollectable, written down for the report fixture`,
    });
  } catch (e) {
    setupError = (e as Error).message;
  }
});

test.afterAll(async () => {
  if (isProject('admin')) {
    // The payroll first: a run still holding an instalment makes every write-off
    // below fail with `assertNoRunInFlight`.
    await clearPayrolls(adminApi, branchId, PAYROLL_PERIOD.month, PAYROLL_PERIOD.year).catch(
      () => undefined,
    );
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    await retireAllMarked(adminHoApi, MARKER_PREFIX).catch(() => undefined);
  }
  await adminApi?.dispose();
  await adminHoApi?.dispose();
  await managerApi?.dispose();
  await reportCtx?.dispose();
  reportCtx = null;
});

/** Fails the case rather than skipping it: a broken fixture is a real failure. */
function requireFixture(): void {
  expect(setupError, 'the known loan set could not be built').toBe('');
}

const rowFor = (rows: OutstandingRow[], employeeId: string): OutstandingRow | undefined =>
  rows.find((r) => r.employeeId === employeeId);

// ───────────────────────────────────────────────────────────────────────────
// Arithmetic against a book whose answer is known
// ───────────────────────────────────────────────────────────────────────────

test.describe('the outstanding report against a known book', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('every employee row is principal minus repaid minus written off', async () => {
    requireFixture();

    const envelope = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}`,
    );
    const rows = envelope.data;

    // Part repaid: two of six instalments consumed, principal 1000 apiece. The
    // interest those instalments carried is NOT repayment of principal and must
    // not appear in `repaid`.
    const part = rowFor(rows, borrower.id);
    expect(part, 'the part-repaid borrower has no row at all').toBeTruthy();
    expect(part!.loans, 'the borrower has two loans, counted as one row').toBe(2);
    expect(part!.principal, 'principal is the sum of both loans').toBe(
      AMOUNTS.partRepaid + AMOUNTS.advance,
    );
    expect(part!.repaid, 'repaid is not the principal component of the PAID ledger rows').toBe(
      AMOUNTS.partRepaidPaid,
    );
    expect(part!.outstanding, 'outstanding is not principal − repaid').toBe(
      AMOUNTS.partRepaid + AMOUNTS.advance - AMOUNTS.partRepaidPaid,
    );
    expect(part!.inFlight, 'nothing is in an unlocked payroll yet').toBe(0);
    expect(part!.department, 'the row lost its department').toBe('Finance');

    // One loan repaid in full and closed, one written off in full, on the same
    // employee. Neither is a DEBT any more, so the borrower leaves the
    // outstanding report altogether.
    //
    // This is what the status fix changed. The query used to exclude only
    // REJECTED and CANCELLED, so a CLOSED or WRITTEN_OFF loan with nothing left
    // owing still reported its full principal as outstanding — and a PENDING
    // request nobody had approved was counted as debt too. `outstanding` now
    // selects LOAN_DEBT_STATUSES, whose own comment in `loan.types.ts` had
    // described this exact fault. The composition of the book, including its
    // terminal loans, is the `portfolio` report's job and is asserted there.
    expect(
      rowFor(rows, settler.id),
      'a borrower whose loans are all closed or written off is still reported as owing',
    ).toBeUndefined();

    // Nothing paid on either loan, and one of them is on hold — which pauses
    // recovery without forgiving the debt.
    const held = rowFor(rows, holder.id);
    expect(held, 'the on-hold borrower dropped out of the report').toBeTruthy();
    expect(held!.outstanding).toBe(AMOUNTS.held + AMOUNTS.aged);
    expect(held!.repaid).toBe(0);
  });

  test('a loan closed with nothing repaid still reports its principal as owed', async () => {
    requireFixture();

    const envelope = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
    );
    const closed = rowFor(envelope.data, closer.id);

    // This case was written while the report excluded only REJECTED and
    // CANCELLED, so a CLOSED loan whose principal was never repaid was still
    // published as money owed. The query now narrows to `LOAN_DEBT_STATUSES`,
    // which is the fix — and the pin was left behind ASSERTING BOTH ANSWERS:
    // the row is absent, and then its `outstanding` equals the old figure.
    // The second line could only ever throw, and did.
    //
    // What remains is the corrected behaviour: a closed loan is not a debt.
    expect(
      closed,
      'a loan that is closed is no longer reported as money owed',
    ).toBeUndefined();
  });

  test('the type filter separates advances from loans', async () => {
    requireFixture();

    const advances = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}&type=ADVANCE`,
    );
    const advanceRow = rowFor(advances.data, borrower.id);
    expect(advanceRow, 'the advance vanished under type=ADVANCE').toBeTruthy();
    expect(advanceRow!.loans, 'type=ADVANCE returned more than the one advance').toBe(1);
    expect(advanceRow!.principal).toBe(AMOUNTS.advance);
    expect(
      rowFor(advances.data, settler.id),
      'an employee with no advance appeared under type=ADVANCE',
    ).toBeUndefined();

    const onlyLoans = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}&type=LOAN`,
    );
    const loanRow = rowFor(onlyLoans.data, borrower.id);
    expect(loanRow!.loans).toBe(1);
    expect(loanRow!.principal).toBe(AMOUNTS.partRepaid);
    expect(loanRow!.outstanding).toBe(AMOUNTS.partRepaid - AMOUNTS.partRepaidPaid);

    // The two halves reconstruct the unfiltered row exactly. A filter that
    // quietly dropped a loan would still look plausible on its own.
    const both = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}`,
    );
    expect(
      advanceRow!.principal + loanRow!.principal,
      'ADVANCE + LOAN does not add up to the unfiltered principal',
    ).toBe(rowFor(both.data, borrower.id)!.principal);
  });

  test('the department filter admits only that department', async () => {
    requireFixture();

    const finance = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}`,
    );

    for (const id of [borrower.id, holder.id]) {
      expect(rowFor(finance.data, id), `a Finance borrower is missing from the filter`).toBeTruthy();
    }
    // `settler` is in Finance too, and is deliberately NOT expected: their loans
    // are closed and written off, so the outstanding report excludes them on
    // status — which the case above pins directly. Listing them here as a
    // borrower who must appear made this case assert the opposite of that one,
    // and whichever ran second was going to fail.
    expect(
      rowFor(finance.data, settler.id),
      'a borrower with nothing left owing came back into the outstanding report',
    ).toBeUndefined();
    for (const id of [payrollBorrower.id, leaver.id, closer.id]) {
      expect(
        rowFor(finance.data, id),
        'an employee from another department came through the department filter',
      ).toBeUndefined();
    }
    // Whoever else is in there, they are in Finance. The filter is spliced into
    // raw SQL, which is where a join that lost its predicate hides.
    for (const row of finance.data) {
      expect(row.department, 'a row from outside the filtered department was returned').toBe(
        'Finance',
      );
    }
  });

  test('paging over one department is stable, and never shows a row twice', async () => {
    requireFixture();

    const all = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}`,
    );
    const everyone = all.data.map((r) => r.employeeId);
    // Two, not three: this file gives Finance three borrowers, and `settler`'s
    // loans are all closed or written off, so the outstanding report excludes
    // them on status. Paging needs more than one row to be worth testing, which
    // two satisfies; the count itself is pinned by the department-filter case.
    expect(everyone.length, 'the department has fewer rows than this file created').toBeGreaterThanOrEqual(2);

    const seen: string[] = [];
    for (let page = 1; page <= everyone.length + 1; page += 1) {
      const slice = await report<OutstandingRow>(
        adminApi,
        `/advance-loans/reports/outstanding?limit=1&page=${page}&departmentId=${finDeptId}`,
      );
      if (slice.data.length === 0) break;
      expect(slice.data.length, 'limit=1 returned more than one row').toBe(1);
      seen.push(slice.data[0].employeeId);
    }

    const firstPageId = seen[0];
    expect(new Set(seen).size, 'a row appeared on two different pages').toBe(seen.length);
    expect([...seen].sort(), 'paging did not reconstruct the whole department').toEqual(
      [...everyone].sort(),
    );

    // Past the end is an empty page, not an error: a client that keeps asking
    // until it gets nothing must not get a 500 for its last request.
    const past = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=1&page=${everyone.length + 5}&departmentId=${finDeptId}`,
    );
    expect(past.data, 'a page past the end was not empty').toEqual([]);

    // Both nonsense inputs are clamped rather than refused: limit 0 becomes 1
    // and page −1 becomes page 1.
    const zeroLimit = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=0&departmentId=${finDeptId}`,
    );
    expect(zeroLimit.data.length, 'limit=0 was not clamped to one row').toBe(1);
    const negativePage = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=1&page=-1&departmentId=${finDeptId}`,
    );
    // `firstPageId`, not `seen[0]`: the reconstruction assertion above used to
    // sort `seen` IN PLACE, so this line compared page one against whichever
    // employee happened to sort first. It agreed by luck while the department
    // held one row whose id also sorted first.
    expect(negativePage.data[0]?.employeeId, 'page=-1 was not clamped to the first page').toBe(
      firstPageId,
    );
  });

  test('the totals belong to the whole filtered book, not to the page', async () => {
    requireFixture();

    const firstOnly = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=1&departmentId=${finDeptId}`,
    );
    const everything = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${finDeptId}`,
    );

    // This case used to pin the opposite, as a defect: `totals` was summed from
    // the PAGE while the screen rendered it under the table as the book's
    // total, so with more employees carrying a balance than the page limit, the
    // figure a finance reader took away was the first page and nothing else.
    // The report totals the filtered book now, and the page only decides which
    // rows are shown.
    const book = everything.data.reduce((a, r) => a + r.principal, 0);
    expect(
      everything.totals?.principal,
      'the full page total does not match the rows it was built from',
    ).toBe(book);
    expect(
      firstOnly.totals?.principal,
      'the totals went back to being page-scoped, which under-reports the book',
    ).toBe(book);
  });

  test('the loanTypeId filter can never match anything', async () => {
    requireFixture();

    // BUG?: `loan_type_id` is never written. Nothing in `AdvanceLoansService`,
    // the import path or the DTOs sets it, so the LoanType catalogue is dead
    // code and this filter silently returns an empty report for every id — the
    // answer a reader will read as "no employee in that category owes anything".
    const empty = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&loanTypeId=${crypto.randomUUID()}`,
    );
    expect(
      empty.data,
      'loanTypeId matched something — a loan type is now being recorded',
    ).toEqual([]);

    // BUG?: the value is cast in SQL (`${departmentId}::uuid`) with nothing
    // validating it first, so a malformed id reaches Postgres and comes back as
    // a server fault rather than a 400. Asserted loosely because either status
    // is a refusal; the note is what records which one it is.
    await expect(
      report<OutstandingRow>(adminApi, '/advance-loans/reports/outstanding?departmentId=not-a-uuid'),
    ).rejects.toThrow(/failed: (400|500)/);
  });

  test('every report carries the same meta contract', async () => {
    requireFixture();

    const paths = [
      '/advance-loans/reports/outstanding?limit=5',
      '/advance-loans/reports/portfolio',
      '/advance-loans/reports/emi-due',
      '/advance-loans/reports/overdue',
      '/advance-loans/reports/interest-earned',
      '/advance-loans/reports/my-statement',
    ];

    for (const path of paths) {
      const answer = await report<unknown>(adminApi, path).catch((e: Error) => e);
      if (answer instanceof Error) {
        // The one refusal that is a fact about the ACCOUNT rather than about
        // the report: an administrative login with no employee record behind it
        // has no statement of its own.
        expect(answer.message, `${path} failed`).toMatch(/not linked to an employee record/);
        continue;
      }
      const envelope = answer;
      expect(envelope.meta, `${path} answered without meta`).toBeTruthy();
      expect(envelope.meta.basis, `${path} does not declare the LOCKED basis`).toBe('LOCKED');
      expect(
        Array.isArray(envelope.meta.openPayrolls),
        `${path} does not report which payroll runs are open`,
      ).toBe(true);
      expect(envelope.meta.asOf, `${path} did not date its own figures`).toBeTruthy();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Portfolio
// ───────────────────────────────────────────────────────────────────────────

test.describe('the portfolio report groups the book', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('each status and type is one group, and the known set is in it', async () => {
    requireFixture();

    const envelope = await report<PortfolioRow>(adminApi, '/advance-loans/reports/portfolio');
    const rows = envelope.data;

    // The grouping claim: `groupBy(['status','type'])` means one row per pair,
    // and a duplicate pair would mean the report is double counting the book.
    const keys = rows.map((r) => `${r.status}/${r.type}`);
    expect(new Set(keys).size, 'the same status/type pair appeared twice').toBe(keys.length);

    const find = (status: string, type: string) =>
      rows.find((r) => r.status === status && r.type === type);

    // Every state this file put in the book has to be somewhere in the
    // composition. Counts are asserted as a floor, never as equality: the
    // grouping is book-wide and other specs are borrowing too.
    for (const [status, type, principal] of [
      ['ACTIVE', 'LOAN', AMOUNTS.partRepaid],
      ['ACTIVE', 'ADVANCE', AMOUNTS.advance],
      ['WRITTEN_OFF', 'LOAN', AMOUNTS.writtenOff],
      ['ON_HOLD', 'LOAN', AMOUNTS.held],
      // Two of this file's loans are CLOSED — the fully repaid one and the one
      // closed with nothing paid — so the group's principal covers both.
      ['CLOSED', 'LOAN', AMOUNTS.closedUnpaid + AMOUNTS.completed],
    ] as Array<[string, string, number]>) {
      const group = find(status, type);
      expect(group, `the book has no ${status}/${type} group despite one being created`).toBeTruthy();
      expect(group!.count, `the ${status}/${type} group counts nothing`).toBeGreaterThanOrEqual(1);
      expect(
        group!.principal,
        `the ${status}/${type} group's principal is below the loan this file put in it`,
      ).toBeGreaterThanOrEqual(principal);
    }

    // Portfolio counts requests, not debts: a PENDING request has a principal
    // figure and no money has moved. It is in here, which is what makes the
    // report a composition of the BOOK rather than of the debt.
    for (const row of rows) {
      expect(row.count, 'a group was returned with no members').toBeGreaterThan(0);
      expect(row.outstanding, 'a group reported a negative balance').toBeGreaterThanOrEqual(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// EMI due
// ───────────────────────────────────────────────────────────────────────────

test.describe('the EMI due report selects a cycle', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('month and year pick the instalments of that cycle and no other', async () => {
    requireFixture();

    const now = cycleBack(0);
    const envelope = await report<EmiDueRow>(
      adminApi,
      `/advance-loans/reports/emi-due?month=${now.month}&year=${now.year}`,
    );

    expect(envelope.meta.month, 'the report did not echo the cycle it answered for').toBe(now.month);
    expect(envelope.meta.year).toBe(now.year);

    // Everything returned is due in the cycle asked for. `dueCycleKey` is a
    // stored column, so a row from a neighbouring month means the key and the
    // date have drifted apart.
    for (const row of envelope.data) {
      const due = new Date(row.dueDate);
      expect(due.getUTCMonth() + 1, `${row.scheduleId} is not due in the cycle asked for`).toBe(
        now.month,
      );
      expect(due.getUTCFullYear()).toBe(now.year);
    }

    const mine = envelope.data.filter((r) => r.loanId === loans[ref('pay')]);
    expect(mine.length, 'the loan whose first instalment is due this cycle is missing').toBe(1);
    expect(mine[0].installmentNo).toBe(1);
    expect(mine[0].emiAmount, 'the instalment is not the principal split four ways').toBe(
      AMOUNTS.payroll / 4,
    );
    expect(mine[0].status, 'an unrecovered instalment is not SCHEDULED').toBe('SCHEDULED');

    // The part-repaid loan started three cycles ago, so this cycle is its
    // FOURTH instalment — the arithmetic that proves the cycle selection is
    // about the schedule and not about the loan.
    const running = envelope.data.filter((r) => r.loanId === loans[ref('part')]);
    expect(running.length, 'the running loan has no instalment this cycle').toBe(1);
    expect(running[0].installmentNo, 'the wrong instalment of the running loan was selected').toBe(
      4,
    );
  });

  test('a later cycle selects later instalments, and a cycle beyond every tenure is empty', async () => {
    requireFixture();

    // Two cycles out is the part-repaid loan's sixth and last instalment.
    const later = cycleBack(-2);
    const ahead = await report<EmiDueRow>(
      adminApi,
      `/advance-loans/reports/emi-due?month=${later.month}&year=${later.year}`,
    );
    const tail = ahead.data.filter((r) => r.loanId === loans[ref('part')]);
    expect(tail.length, 'the final instalment is not due where the schedule says it is').toBe(1);
    expect(tail[0].installmentNo).toBe(6);

    // No loan in this product can have a tenure of six years — the configured
    // maximum is twelve instalments — so a cycle that far out is the "nothing
    // due" case rather than a sampling of a quiet month.
    const empty = cycleBack(-72);
    const nothing = await report<EmiDueRow>(
      adminApi,
      `/advance-loans/reports/emi-due?month=${empty.month}&year=${empty.year}`,
    );
    expect(nothing.data, 'a cycle six years out has instalments due in it').toEqual([]);
    expect(nothing.totals?.count, 'an empty cycle did not total zero').toBe(0);
  });

  test('includeHeld is what decides whether a paused loan is listed', async () => {
    requireFixture();

    const now = cycleBack(0);
    const base = `/advance-loans/reports/emi-due?month=${now.month}&year=${now.year}`;

    const without = await report<EmiDueRow>(adminApi, `${base}&includeHeld=false`);
    const withHeld = await report<EmiDueRow>(adminApi, `${base}&includeHeld=true`);

    const heldLoan = loans[ref('hold')];
    expect(
      without.data.some((r) => r.loanId === heldLoan),
      'an ON_HOLD loan was listed as due for recovery — payroll will not take it',
    ).toBe(false);
    expect(
      withHeld.data.some((r) => r.loanId === heldLoan),
      'includeHeld=true did not surface the paused loan',
    ).toBe(true);

    // `includeHeld` used to drop the WHOLE request-status predicate rather than
    // only the ON_HOLD half, so a CLOSED / WRITTEN_OFF / SETTLED loan with an
    // unpaid schedule row was listed as due for recovery, and so was a request
    // nobody had approved. "Include the paused ones" and "include the finished
    // ones" are different questions and only the first has a parameter.
    //
    // The flag moves exactly one status now, so a terminal loan is not due
    // either way — which is the assertion, in both directions.
    const closedLoan = loans[ref('closed')];
    expect(
      without.data.some((r) => r.loanId === closedLoan),
      'a CLOSED loan was listed as due without asking for held loans',
    ).toBe(false);
    expect(
      withHeld.data.some((r) => r.loanId === closedLoan),
      'includeHeld admitted a terminal loan again — it widens ON_HOLD, not the whole predicate',
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Overdue ageing
// ───────────────────────────────────────────────────────────────────────────

test.describe('the overdue report ages an instalment', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('every bucket boundary falls on the side the report claims', async () => {
    requireFixture();

    const dueDay = dueDayOf(firstCycle.aged);
    const agedLoan = loans[ref('aged')];

    // One instalment, read at eight different `asOf` dates. Ageing an existing
    // row is the only way to land exactly on a boundary — a fixture built from
    // eight loans would land wherever the calendar put it.
    const boundaries: Array<[number, string | null]> = [
      [0, null], // due today is not overdue
      [1, '1-30'],
      [30, '1-30'],
      [31, '31-60'],
      [60, '31-60'],
      [61, '61-90'],
      [90, '61-90'],
      [91, '90+'],
    ];

    for (const [days, bucket] of boundaries) {
      const asOf = shiftDays(dueDay, days);
      const envelope = await report<OverdueRow>(
        adminApi,
        `/advance-loans/reports/overdue?asOf=${asOf}`,
      );
      const mine = envelope.data.find((r) => r.loanId === agedLoan);

      if (bucket === null) {
        expect(
          mine,
          `an instalment due on ${asOf} was reported overdue on the day it fell due`,
        ).toBeUndefined();
        continue;
      }

      expect(mine, `the aged instalment vanished at ${days} days past due`).toBeTruthy();
      expect(mine!.overdueDays, `the age at ${asOf} is not ${days} days`).toBe(days);
      expect(mine!.bucket, `${days} days past due landed in the wrong bucket`).toBe(bucket);
      expect(mine!.amountDue, 'the whole instalment is owed, none of it paid').toBe(AMOUNTS.aged);
    }
  });

  test('the buckets summarise the rows they were built from', async () => {
    requireFixture();

    const asOf = shiftDays(dueDayOf(firstCycle.aged), 91);
    const envelope = await report<OverdueRow>(
      adminApi,
      `/advance-loans/reports/overdue?asOf=${asOf}`,
    );

    expect(
      Object.keys(envelope.buckets ?? {}),
      'the four ageing buckets are not all reported',
    ).toEqual(['1-30', '31-60', '61-90', '90+']);

    const counted = Object.values(envelope.buckets ?? {}).reduce((a, b) => a + b.count, 0);
    expect(counted, 'the buckets and the rows disagree about how many are overdue').toBe(
      envelope.data.length,
    );
    expect(envelope.totals?.count).toBe(envelope.data.length);
    expect(envelope.meta.asOf.slice(0, 10), 'the report did not date itself as asked').toBe(asOf);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Interest earned
// ───────────────────────────────────────────────────────────────────────────

test.describe('the interest earned report windows the ledger', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('from and to select the cycles the interest was actually collected in', async () => {
    requireFixture();

    const first = firstCycle.partRepaid;
    const second = cycleBack(2);
    const envelope = await report<InterestRow>(
      adminApi,
      `/advance-loans/reports/interest-earned?from=${firstDayOf(first)}&to=${dueDayOf(second)}`,
    );

    for (const cycle of [first, second]) {
      const row = envelope.data.find((r) => r.year === cycle.year && r.month === cycle.month);
      expect(row, `no interest reported for ${period(cycle)}, where an instalment was paid`).toBeTruthy();
      expect(
        row!.interest,
        `the interest collected in ${period(cycle)} is below what this file's loan paid`,
      ).toBeGreaterThanOrEqual(PART_REPAID_INTEREST_PER_INSTALMENT);
      expect(row!.principal, 'the principal collected in the cycle is missing').toBeGreaterThanOrEqual(
        AMOUNTS.partRepaid / 6,
      );
    }

    // The window is closed at both ends. A cycle outside it must not be in the
    // answer at all, or a period report silently includes the month before it.
    const outside = cycleBack(-2);
    expect(
      envelope.data.some((r) => r.year === outside.year && r.month === outside.month),
      'a cycle outside the window was included',
    ).toBe(false);
  });

  test('a window with nothing in it, and a window that runs backwards', async () => {
    requireFixture();

    // Before any employee in this database joined, so the emptiness is a fact
    // about the window rather than about who happens to be borrowing.
    const quiet = await report<InterestRow>(
      adminApi,
      '/advance-loans/reports/interest-earned?from=2019-01-01&to=2019-12-31',
    );
    expect(quiet.data, 'a window predating the company reported interest').toEqual([]);
    expect(quiet.totals?.interest, 'an empty window did not total zero').toBe(0);

    // Reversed bounds become `BETWEEN high AND low`, which matches nothing.
    // Reported here as the current answer: an empty report, not a 400 — so a
    // client that swapped its date pickers gets "no interest was earned".
    const backwards = await report<InterestRow>(
      adminApi,
      `/advance-loans/reports/interest-earned?from=${firstDayOf(cycleBack(2))}&to=${firstDayOf(cycleBack(3))}`,
    );
    expect(backwards.data, 'a reversed window is no longer empty').toEqual([]);
    expect(backwards.totals?.interest).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Statements
// ───────────────────────────────────────────────────────────────────────────

test.describe('statements', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'driven as ADMIN, asserted for every role');
  });

  test('my-statement answers for every role and never leaks another employee', async () => {
    requireFixture();

    const mine = new Set(Object.values(loans));

    for (const role of ['admin', 'hr', 'manager', 'employee'] as const) {
      const api = await ApiClient.as(role);
      try {
        const answer = await report<StatementLoan>(api, '/advance-loans/reports/my-statement').catch(
          (e: Error) => e,
        );

        if (answer instanceof Error) {
          // The one legitimate refusal: an administrative login with no
          // employee record behind it. Anything else is a fault.
          expect(answer.message, `my-statement failed for ${role}`).toMatch(
            /not linked to an employee record/,
          );
          continue;
        }

        expect(answer.meta.basis, `${role}'s statement does not declare its basis`).toBe('LOCKED');
        for (const loan of answer.data) {
          expect(
            mine.has(loan.id),
            `${role}'s own statement contains a loan belonging to somebody else`,
          ).toBe(false);
        }
      } finally {
        await api.dispose();
      }
    }
  });

  test("one employee's statement is ADMIN and HR only, and is exactly their loans", async () => {
    requireFixture();

    const expected = [loans[ref('part')], loans[ref('adv')]].sort();

    const asAdmin = await report<StatementLoan>(
      adminApi,
      `/advance-loans/reports/employee/${borrower.id}/statement`,
    );
    expect(
      asAdmin.data.map((l) => l.id).sort(),
      "the borrower's statement is not their two loans",
    ).toEqual(expected);

    const part = asAdmin.data.find((l) => l.id === loans[ref('part')]);
    expect(part!.outstanding, 'the statement disagrees with the outstanding report').toBe(
      AMOUNTS.partRepaid - AMOUNTS.partRepaidPaid,
    );

    const hrApi = await ApiClient.as('hr');
    const managerApiLocal = await ApiClient.as('manager');
    const employeeApi = await ApiClient.as('employee');
    try {
      // HR reads the same book — WHERE HR can see the branch at all. Branch
      // access is a property of the seeded user (`branchAccess` /
      // isGlobalBranchAccess) and there is no HTTP surface to grant it, so on a
      // database whose HR account is pinned to its home branch this half is not
      // reachable and the request is refused by branch scoping before the
      // report is ever consulted. The ADMIN read above and the two refusals
      // below carry the case in that event.
      const hrBranches = await hrApi
        .get<Array<{ id: string }>>('/branches')
        .catch(() => [] as Array<{ id: string }>);
      const hrSeesBranch = (Array.isArray(hrBranches) ? hrBranches : []).some(
        (b) => b.id === branchId,
      );
      if (hrSeesBranch) {
        scopeTo(hrApi, branchId);
        const asHr = await report<StatementLoan>(
          hrApi,
          `/advance-loans/reports/employee/${borrower.id}/statement`,
        );
        expect(asHr.data.map((l) => l.id).sort(), 'HR reads a different book').toEqual(expected);
      }

      // The direct-object-reference surface, closed for the two roles that have
      // no business reading a colleague's debts.
      await expect(
        managerApiLocal.get(`/advance-loans/reports/employee/${borrower.id}/statement`),
      ).rejects.toThrow(/403/);
      await expect(
        employeeApi.get(`/advance-loans/reports/employee/${borrower.id}/statement`),
      ).rejects.toThrow(/403/);
    } finally {
      await hrApi.dispose();
      await managerApiLocal.dispose();
      await employeeApi.dispose();
    }

    // An id nobody owns is an empty statement rather than a 404 — the route
    // cannot distinguish "no such employee" from "an employee who never
    // borrowed", and does not pretend to.
    const nobody = await report<StatementLoan>(
      adminApi,
      `/advance-loans/reports/employee/${crypto.randomUUID()}/statement`,
    );
    expect(nobody.data, 'an unknown employee has a loan history').toEqual([]);

    // A malformed id is refused by the pipe before any query runs.
    await expect(
      adminApi.get('/advance-loans/reports/employee/not-a-uuid/statement'),
    ).rejects.toThrow(/400/);
  });

  test('an employee who has left keeps their loan history', async () => {
    requireFixture();

    const before = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
    );
    const was = rowFor(before.data, leaver.id);
    expect(was, 'the leaver had no row to begin with').toBeTruthy();

    await terminateEmployee(adminApi, leaver.id);

    const employee = await adminApi.get<{ status: string }>(`/employees/${leaver.id}`);
    expect(employee.status, 'the termination did not take').toBe('INACTIVE');

    // The statutory case: money owed by someone who has left is exactly the
    // money an audit asks about, so their row must survive the offboarding.
    const after = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
    );
    const still = rowFor(after.data, leaver.id);
    expect(still, "a leaver's outstanding balance disappeared from the report").toBeTruthy();
    expect(still!.principal).toBe(AMOUNTS.leaver);
    expect(still!.repaid).toBe(AMOUNTS.leaverPaid);
    expect(still!.outstanding, "the leaver's balance changed when they left").toBe(
      AMOUNTS.leaver - AMOUNTS.leaverPaid,
    );

    const statement = await report<StatementLoan>(
      adminApi,
      `/advance-loans/reports/employee/${leaver.id}/statement`,
    );
    expect(
      statement.data.map((l) => l.id),
      "the leaver's statement is no longer readable",
    ).toEqual([loans[ref('leaver')]]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The LOCKED basis, proved with a real payroll run
// ───────────────────────────────────────────────────────────────────────────

/**
 * A run of this file's own, in its own branch, over one employee.
 *
 * Everything here is scoped as narrowly as it can be: a period fifty months out
 * that no other spec picks, `employeeIds` naming one borrower, and `E2E-BR2`
 * rather than Head Office. A payroll run is the most destructive thing a loan
 * spec can do — locking one settles every recovery it touched — so the blast
 * radius is one employee this file created.
 *
 * The run is staged in the first case rather than in `beforeAll` so a failure to
 * generate is attributable, and the whole group skips rather than fails when the
 * environment refuses (attendance not processed, a run already in the period).
 */
test.describe('while a payroll run is open, and after it locks', () => {
  let payrollId = '';
  let payrollError = '';
  let recovered = 0;

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'payroll is an administrative flow');
  });

  test('a generated run leaves outstanding alone and reports itself as in flight', async () => {
    requireFixture();

    const day = `${PAYROLL_PERIOD.year}-${pad2(PAYROLL_PERIOD.month)}-02`;
    await adminApi
      .post('/attendances/manual', {
        employeeId: payrollBorrower.id,
        date: day,
        checkIn: `${day}T09:00:00.000Z`,
        checkOut: `${day}T18:00:00.000Z`,
        status: 'PRESENT',
        notes: `${RUN} — so the period can be run`,
      })
      .catch(() => undefined);

    const run = await runPayroll(adminApi, {
      month: PAYROLL_PERIOD.month,
      year: PAYROLL_PERIOD.year,
      branchId,
      employeeIds: [payrollBorrower.id],
    }).catch((e: Error) => {
      payrollError = e.message;
      return null;
    });
    test.skip(!run, `no payroll run could be staged here: ${payrollError}`);
    payrollId = run!.id;

    const envelope = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
    );
    const row = rowFor(envelope.data, payrollBorrower.id)!;

    // The claim the banner exists to explain: an unlocked run has withheld
    // nothing yet, so the balance is untouched and the amount it intends to
    // take is reported beside it rather than inside it.
    expect(row.outstanding, 'an unlocked payroll moved the outstanding balance').toBe(
      AMOUNTS.payroll,
    );
    expect(row.repaid, 'an unlocked payroll was counted as repayment').toBe(0);
    expect(row.inFlight, 'the money the open run intends to take is not reported').toBeGreaterThan(
      0,
    );
    recovered = row.inFlight;

    // And the ledger agrees: the rows exist, they are PENDING, and nothing has
    // moved.
    const ledger = (await deductionsFor(adminApi, loans[ref('pay')])) as Array<{
      status: string;
      amount: string | number;
    }>;
    expect(ledger.length, 'the run wrote no ledger row against the loan').toBeGreaterThan(0);
    expect(
      ledger.every((d) => d.status === 'PENDING'),
      'a ledger row was already PAID before the run was locked',
    ).toBe(true);

    // The run this file made is named in meta, which is what the screen's
    // banner counts.
    expect(
      envelope.meta.openPayrolls.some((p) => p.id === payrollId),
      'the open run is not reported in meta.openPayrolls',
    ).toBe(true);
  });

  test('the screen says so, and counts the runs it was given', async ({ page, problems }) => {
    requireFixture();
    test.skip(!payrollId, 'no payroll run is open');

    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();
    await reports.openTab('outstanding');

    const envelope = await report<OutstandingRow>(
      adminApi,
      '/advance-loans/reports/outstanding?limit=100',
    );
    const open = envelope.meta.openPayrolls;
    expect(open.length, 'the run this file opened is not in the server answer').toBeGreaterThan(0);

    await expect.poll(() => reports.hasOpenPayrollBanner(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => reports.openRunCount(), { timeout: 15_000 }).toBe(open.length);

    settle(problems, 'the loan reports while a payroll run is open');
  });

  test('locking moves the money, and asOf still reports the balance as it was', async () => {
    requireFixture();
    test.skip(!payrollId, 'no payroll run is open');

    await adminApi.post(`/payrolls/${payrollId}/submit`, {});
    await adminApi.post(`/payrolls/${payrollId}/approve`, { notes: `${RUN} — approved to lock` });
    await lockPayroll(adminApi, payrollId);

    // When the cycle takes the WHOLE balance, the loan closes and leaves the
    // outstanding report — it is not a debt any more — so the report can no
    // longer answer "how much was repaid" and the row lookup returns nothing.
    // How much a cycle can take depends on the subject's pay and on the
    // recovery policy in force, so which of the two endings this run gets is
    // not fixed. The loan's own record is asked in that case, which is where
    // the money actually landed.
    const paidLoan = await adminApi.get<{ status?: string; amountRepaid?: number | string }>(
      `/advance-loans/${loans[ref('pay')]}`,
    );
    if (paidLoan?.status && !['ACTIVE', 'ON_HOLD', 'OVERDUE', 'DISBURSED'].includes(String(paidLoan.status))) {
      expect(
        Number(paidLoan.amountRepaid ?? 0),
        'the lock closed the loan without booking the repayment against it',
      ).toBeCloseTo(recovered, 0);
      return;
    }

    await expect
      .poll(
        async () => {
          const envelope = await report<OutstandingRow>(
            adminApi,
            `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
          );
          return rowFor(envelope.data, payrollBorrower.id)?.repaid ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBe(recovered);

    const now = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?limit=200&departmentId=${opsDeptId}`,
    );
    const live = rowFor(now.data, payrollBorrower.id)!;
    expect(live.outstanding, 'the locked recovery did not reduce the balance').toBe(
      AMOUNTS.payroll - recovered,
    );
    expect(live.inFlight, 'the recovery is still reported as in flight after locking').toBe(0);

    // The historical case. `repaid` is recomputed from the ledger and filtered
    // by the CYCLE the deduction belongs to, so a report dated before that cycle
    // shows the balance as it stood — which is the whole reason `asOf` cannot
    // read the denormalised `amountRepaid` column.
    const asOf = isoDay(new Date());
    const historical = await report<OutstandingRow>(
      adminApi,
      `/advance-loans/reports/outstanding?asOf=${asOf}&limit=200&departmentId=${opsDeptId}`,
    );
    const then = rowFor(historical.data, payrollBorrower.id)!;
    expect(then.repaid, 'a repayment from a later cycle was counted in a historical report').toBe(0);
    expect(then.outstanding, 'the historical balance is not the balance as it was').toBe(
      AMOUNTS.payroll,
    );

    // BUG?: those two answers came from the same book seconds apart, and the
    // undated one is not the same as `asOf = today` even though its own
    // `meta.asOf` says today. Without `asOf` the cycle filter is dropped
    // altogether, so the default report counts repayments booked in cycles that
    // have not happened yet and dates itself as if it had not.
    expect(now.meta.asOf.slice(0, 10), 'the undated report no longer dates itself as today').toBe(
      asOf,
    );

    // The run has left the open list, which is what turns the banner off.
    expect(
      now.meta.openPayrolls.some((p) => p.id === payrollId),
      'a LOCKED run is still being reported as open',
    ).toBe(false);

    const ledger = (await deductionsFor(adminApi, loans[ref('pay')])) as Array<{ status: string }>;
    expect(
      ledger.some((d) => d.status === 'PAID'),
      'locking the run did not move a single ledger row to PAID',
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The export
// ───────────────────────────────────────────────────────────────────────────

/** Cell text as the browser renders it, one array per row. */
async function tableCells(page: Page): Promise<string[][]> {
  return page
    .getByTestId('loan-report-row')
    .evaluateAll((rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim()),
      ),
    );
}

/**
 * Both sides of the comparison, put in one form before they are compared.
 *
 * `formatCurrency` goes through `Intl.NumberFormat`, which separates the
 * currency code from the amount with a NON-BREAKING space. That character
 * reaches the DOM and the Blob alike, so folding it here is not papering over a
 * difference — it is refusing to fail a report comparison over a code point
 * neither the screen nor the file chose.
 */
const norm = (value: string) => value.replace(/\u00a0/g, ' ').trim();

test.describe('the exported file is the table', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the loan book is an HR/admin report');
  });

  test('every populated tab exports its own rows, cell for cell', async ({ page, problems }) => {
    requireFixture();

    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();

    const asOf = (
      await report<OutstandingRow>(adminApi, '/advance-loans/reports/outstanding?limit=1')
    ).meta.asOf.slice(0, 10);

    let exported = 0;
    for (const tab of LOAN_REPORT_TABS as LoanReportTab[]) {
      await reports.openTab(tab);
      if ((await reports.rowCount()) === 0) continue;
      exported += 1;

      const columns = await reports.columns();
      const onScreen = await tableCells(page);
      const { fileName, text } = await reports.exportCsv();

      // The name carries the tab AND the date the figures are as of, so two
      // downloads cannot be confused on disk — and a file found later can be
      // dated without opening it.
      expect(fileName, `the ${tab} export is not named for its tab and asOf`).toBe(
        `loan-${tab}-${asOf}.csv`,
      );

      const lines = text.trim().split('\n');
      expect(parseCsvLine(lines[0]), `the ${tab} CSV header is not the table header`).toEqual(
        columns,
      );
      expect(lines.length - 1, `the ${tab} CSV has a different number of rows`).toBe(
        onScreen.length,
      );

      for (let r = 0; r < onScreen.length; r += 1) {
        const csvCells = parseCsvLine(lines[r + 1]);
        expect(csvCells.length, `a ${tab} CSV row has the wrong cell count`).toBe(columns.length);

        for (let c = 0; c < columns.length; c += 1) {
          if (columns[c] === 'Status') {
            // BUG?: the export claims to be built from the same definition the
            // table renders, and for every column whose renderer returns an
            // element it is not: the screen shows the human label ("Fully
            // repaid", "Part paid") and the file writes the raw enum. A reader
            // reconciling a spreadsheet against the screen finds two
            // vocabularies for one column.
            expect(
              norm(csvCells[c]),
              `the ${tab} CSV no longer writes the raw status enum`,
            ).toMatch(/^[A-Z_]*$/);
            expect(
              norm(onScreen[r][c]),
              `the ${tab} screen and file now agree on the status column`,
            ).not.toBe(norm(csvCells[c]));
            continue;
          }
          expect(
            norm(csvCells[c]),
            `the ${tab} CSV disagrees with the table at row ${r + 1}, column ${columns[c]}`,
          ).toBe(norm(onScreen[r][c]));
        }
      }
    }

    expect(exported, 'no tab had a row to export despite a book full of loans').toBeGreaterThan(0);

    settle(problems, 'exporting every populated report tab');
  });

  test('a name carrying a comma and a quote survives the round trip', async ({ page, problems }) => {
    requireFixture();

    // Renamed here rather than at creation because `makeEmployee` builds the
    // name from the marker. The value is the point: an employee called
    // `Ó'Brien, "Jo"` is the case a naive exporter shifts every column of.
    const awkward = `Brien, "Jo" ${RUN}`;
    await adminApi.patch(`/employees/${borrower.id}`, { fullName: awkward }).catch(() => undefined);
    const stored = await adminApi.get<{ fullName: string }>(`/employees/${borrower.id}`);
    test.skip(
      stored.fullName !== awkward,
      'the employee record refused a name containing a comma and a quote',
    );

    await selectBranch(page, branchId);
    const reports = new LoanReportsPage(page);
    await reports.open();
    await reports.openTab('outstanding');

    const onScreen = await tableCells(page);
    const mine = onScreen.find((cells) => cells[0].includes(awkward));
    test.skip(!mine, 'the renamed borrower is not on the first page of the report');

    const { text } = await reports.exportCsv();
    const parsed = text
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => parseCsvLine(line));
    const exportedRow = parsed.find((cells) => cells[0].includes(awkward));

    expect(
      exportedRow,
      'the row with a comma and a quote in its name did not survive the export',
    ).toBeTruthy();
    // Cell for cell against the screen: a broken escape shows up as a shifted
    // column rather than as a missing row, which is exactly what a spreadsheet
    // hides.
    expect(exportedRow!.length, 'the awkward name split its row across columns').toBe(mine!.length);
    expect(norm(exportedRow![0]), 'the name was mangled by the escaping').toBe(norm(mine![0]));

    settle(problems, 'exporting a report row whose name carries a comma');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The two claims that need a loan filed the ordinary way
// ───────────────────────────────────────────────────────────────────────────

test.describe('loans filed through the ordinary path', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'driven as ADMIN against the seeded branch');
  });

  test('a request awaiting approval is not counted as outstanding', async () => {
    requireFixture();

    const amount = 350;

    const before = await report<OutstandingRow>(
      adminHoApi,
      '/advance-loans/reports/outstanding?limit=200',
    );

    const created = await managerApi.post<{ id: string; employeeId: string }>('/advance-loans', {
      type: 'LOAN',
      amount,
      installments: 2,
      reason: `${RUN} — filed, never approved`,
    });

    try {
      const after = await report<OutstandingRow>(
        adminHoApi,
        '/advance-loans/reports/outstanding?limit=200',
      );
      const was = rowFor(before.data, created.employeeId)?.outstanding ?? 0;
      const now = rowFor(after.data, created.employeeId)?.outstanding ?? 0;

      // This case used to pin the opposite, as a defect: no money has left the
      // company — the request is not approved, let alone disbursed — and the
      // outstanding report counted its full principal as owed, because the
      // query excluded only REJECTED and CANCELLED. `LOAN_DEBT_STATUSES` exists
      // for exactly this distinction and says so in its own comment; the report
      // uses it now, so a request awaiting approval is not debt.
      expect(
        now - was,
        'a PENDING request is being counted as outstanding again — the query lost LOAN_DEBT_STATUSES',
      ).toBe(0);
    } finally {
      await managerApi.delete(`/advance-loans/${created.id}`).catch(() => undefined);
    }
  });

  test('with interest switched off, a natively approved loan earns none', async () => {
    requireFixture();

    const id = await liveLoan(managerApi, adminHoApi, {
      amount: 400,
      installments: 4,
      note: `${RUN} — interest flag off`,
      markerPrefix: MARKER_PREFIX,
    });

    try {
      const schedule = await scheduleOf(adminHoApi, id);
      expect(schedule.length, 'the approved loan has no schedule').toBe(4);

      // `loan_interest_enabled` defaults to 'false', and the schedule service
      // forces the method to NONE when it is off whatever the loan says — so
      // every instalment is pure principal and the interest report can only
      // ever be zero for a loan filed this way.
      for (const row of schedule) {
        expect(row.interestComponent, 'an instalment carries interest with the flag off').toBe(0);
        expect(row.emiAmount, 'the instalment is not pure principal').toBe(row.principalComponent);
      }

      // BUG?: the importer does NOT consult that flag — it passes the row's own
      // `interestMethod` straight to the amortization engine — so
      // `interest-earned` can report interest this environment believes is
      // switched off. That is what the FLAT loan at the top of this file proves,
      // and it is why the assertion above is about the native path only.
      const loan = await adminHoApi.get<{ interestMethod: string | null }>(`/advance-loans/${id}`);
      expect(
        loan.interestMethod,
        'a natively created loan now records an interest method with the flag off',
      ).toBe('NONE');
    } finally {
      await adminHoApi
        .post(`/advance-loans/${id}/write-off`, { reason: `${RUN} — journey finished` })
        .catch(() => undefined);
    }
  });
});
