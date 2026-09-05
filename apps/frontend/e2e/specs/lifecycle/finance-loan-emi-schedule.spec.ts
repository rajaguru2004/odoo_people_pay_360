import * as XLSX from 'xlsx';
import { request as newRequest } from '@playwright/test';
import { test, expect, settle, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { LoanLifecyclePage, selectBranch } from '../../pages/loan-lifecycle';
import {
  marker,
  retire,
  retireAllMarked,
  ensureAllowance,
  liveLoan,
  loanOf,
  scheduleOf,
  quoteOf,
  makeEmployee,
  terminateEmployee,
  branchIdByCode,
  withSettings,
  flagFlipAllowed,
  type ScheduleRow,
  type TestEmployee,
} from '../../loan-support';

/**
 * The amortization ENGINE, as a user meets it: over HTTP, and on the schedule
 * table.
 *
 * `loan-amortization.util.spec.ts` already proves the maths as pure functions —
 * 480 lines of it, table-driven, no database. Nothing here repeats that. What
 * it cannot prove is that the same maths survives the trip: that the settings
 * layer feeds the engine the method and rate the operator actually chose, that
 * the persisted rows are the rows the engine returned, that regeneration
 * re-amortizes the REMAINING balance rather than the original principal, and
 * that the table on screen is showing the plan the server holds. Every one of
 * those has been a real defect class in this module; none of them is visible
 * from a unit test.
 *
 * ## The money invariants, asserted on every schedule this file creates
 *
 * `assertScheduleSound` is applied to EVERY generated plan, imported, native or
 * regenerated. It is not decoration: the engine computes in integer minor units
 * precisely so that `sum(principalComponent) === principal` is an EQUALITY, and
 * so a schedule can never leave a 0.01–1.00 residue that nobody can collect.
 * Asserting it once per schedule is what makes the rest of the file's numbers
 * meaningful — an EMI that matches the formula but does not reconcile is still
 * a broken plan.
 *
 * ## Why the importer is the seeding path for anything with a rate
 *
 * `loan_interest_enabled` defaults to `'false'`, and `LoanScheduleService.generate`
 * reads it on every approval: with it off, EVERY natively-approved loan gets
 * `interestMethod = NONE` and `annualRatePercent = 0`, whatever is on the
 * record. Nor is there any way to put a rate there in the first place —
 * `CreateAdvanceLoanDto` carries `type`, `amount`, `reason`, `installments` and
 * nothing else, and the only DTO in the module with an `interestRate` field is
 * `convert`. The IMPORTER is therefore the one HTTP surface that can put a
 * method and a rate onto a loan, which is why the interest half of this file is
 * seeded from a workbook built in memory rather than from the request form.
 *
 * That is also, by itself, a finding: the importer never consults
 * `loan_interest_enabled` at all (see the kill-switch case), so the switch that
 * governs the native path does not govern the imported one.
 *
 * ## What this file deliberately does NOT reach
 *
 * WEEKLY (52/yr) and QUARTERLY (4/yr) frequencies, `gracePeriods` and the fee
 * and employer-subsidy inputs are all engine parameters with NO HTTP surface:
 * the import sheet has fourteen columns and none of them is a frequency, the
 * importer hard-codes `frequency: 'MONTHLY'`, and no DTO carries a grace count.
 * Rather than pretend, one case asserts that fact directly and the engine-level
 * coverage stays where it can actually run.
 *
 * ## Subjects, and the one that has to be a seeded account
 *
 * The imported loans go to an employee this file makes (`makeEmployee`, start
 * date 2020-01-01 — the import validator refuses a disbursement dated before the
 * employee joined, so a subject who has "been here" for years is the only kind
 * that works). Nothing contends with it.
 *
 * The natively FILED loans cannot use that employee: `POST /advance-loans`
 * creates the request for the CALLER, and an API-created employee has no usable
 * login at all (`makeEmployee` documents why — the temp password is only
 * emailed). So those go through the seeded `employee` account, under the same
 * `ensureAllowance` / `retire`-in-`afterEach` discipline as
 * `finance-loan-lifecycle.spec.ts`, because `loan_max_active_per_employee` is 2
 * and this file files a loan per case.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** Every loan this file creates carries this in its reason. */
const MARKER_PREFIX = 'pw-loanemi-';
const mark = marker(MARKER_PREFIX);

/** Reference numbers must match /^[A-Za-z0-9/_-]{3,40}$/. */
const REF_BASE = `LN-${mark}`.toUpperCase().replace(/[^A-Z0-9/_-]/g, '-').slice(0, 30);
let refSeq = 0;
const nextRef = () => `${REF_BASE}-${String(++refSeq).padStart(2, '0')}`;

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The fixed column block of the import sheet, in order — the contract. */
const IMPORT_HEADERS = [
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

/**
 * The employee the importer files against — made by this file, so nothing
 * contends with it. Set in `beforeAll`; the seeded `EMP002` is not used because
 * it is shared with `finance-loan-lifecycle.spec.ts`'s importer half.
 */
let importSubject = '';

// ───────────────────────────────────────────────────────────────────────────
// Shapes
// ───────────────────────────────────────────────────────────────────────────

/**
 * The corner of the loan record this file asserts on.
 *
 * `loanOf` deliberately returns an open record — the detail route answers with
 * the whole request plus its employee, approver, attachments and ledger, and
 * every spec wants a different part of it — so the narrowing happens here, in
 * one place, rather than at each read.
 */
interface LoanRecord {
  id: string;
  status: string;
  type: string;
  amount: string | number;
  installments: number;
  installmentAmount: string | number | null;
  amountRepaid: string | number;
  interestMethod: string | null;
  interestRate: string | number | null;
  deductionFrequency: string | null;
  gracePeriods: number | null;
  scheduleVersion: number | null;
  referenceNo: string | null;
  reason: string | null;
}

const loanRec = async (api: ApiClient, id: string): Promise<LoanRecord> =>
  (await loanOf(api, id)) as unknown as LoanRecord;

// ───────────────────────────────────────────────────────────────────────────
// Money, in the engine's own units
// ───────────────────────────────────────────────────────────────────────────

/**
 * Minor units, because that is what the engine works in.
 *
 * Every money assertion in this file is made on integers. Comparing the major
 * units would need a tolerance, and a tolerance is exactly what the engine was
 * rewritten to make unnecessary — `sum(principal) === principal` is an equality
 * here, and it should fail if it ever stops being one.
 */
const MINOR = 100;
const minor = (v: unknown): number => Math.round(Number(v) * MINOR);
const sumMinor = (values: unknown[]): number =>
  values.reduce<number>((a, v) => a + minor(v), 0);

/**
 * `splitEvenlyLastAbsorbs`, reimplemented here rather than imported.
 *
 * The whole point of this file is to check the server's arithmetic against an
 * expectation computed independently of it; importing the backend's own helper
 * would make every comparison a tautology. Backend code is also not reachable
 * from the Playwright process without pulling Nest in.
 */
function splitLastAbsorbs(wholeMinor: number, n: number): number[] {
  const base = Math.floor(wholeMinor / n);
  const parts = new Array<number>(n).fill(base);
  parts[n - 1] = wholeMinor - base * (n - 1);
  return parts;
}

/** FLAT total interest: principal × rate × (n / periodsPerYear) / 100. */
function flatInterestMinor(
  principalMinor: number,
  ratePercent: number,
  n: number,
  periodsPerYear: number,
): number {
  return Math.round((principalMinor * ratePercent * (n / periodsPerYear)) / 100);
}

/**
 * The annuity plan: EMI = P·r·(1+r)^n / ((1+r)^n − 1), interest on the live
 * balance, and the final row's principal absorbing every unit of residue.
 */
function annuityPlan(
  principalMinor: number,
  ratePercent: number,
  n: number,
  periodsPerYear: number,
  roundingUnitMinor = 1,
): { levelEmi: number; principal: number[]; interest: number[]; emi: number[] } {
  const r = ratePercent / 100 / periodsPerYear;
  const growth = Math.pow(1 + r, n);
  const rawEmi = (principalMinor * r * growth) / (growth - 1);
  const levelEmi = Math.round(rawEmi / roundingUnitMinor) * roundingUnitMinor;

  const principal: number[] = [];
  const interest: number[] = [];
  let balance = principalMinor;
  for (let k = 0; k < n; k++) {
    const int = Math.round(balance * r);
    const part = k === n - 1 ? balance : Math.min(levelEmi - int, balance);
    principal.push(part);
    interest.push(int);
    balance -= part;
  }
  return {
    levelEmi,
    principal,
    interest,
    emi: principal.map((p, i) => p + interest[i]),
  };
}

/** UTC last day of the month a date falls in. */
const lastDayOfMonth = (d: Date): number =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

const asUTC = (iso: string): Date => new Date(iso);

/** `YYYY-MM-DD`, so a failure names the date rather than a timestamp. */
const ymd = (iso: string): string => asUTC(iso).toISOString().slice(0, 10);

// ───────────────────────────────────────────────────────────────────────────
// THE money invariants — asserted on every schedule this file produces
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything that must be true of ANY plan the engine emits, whatever method,
 * rate or frequency produced it.
 *
 * A schedule that violates one of these is not "slightly off": it is a balance
 * that will never reach zero, an instalment payroll cannot deduct, or a gap in
 * the numbering that the skip and prepay operations both index into. The engine
 * throws rather than persist one, so a failure here means either the throw
 * stopped working or the persistence layer changed the rows on the way past.
 *
 * `amortized` is the baseline this plan is built on, and every caller states it
 * EXPLICITLY rather than letting the helper infer it — the two baselines are
 * different numbers and getting them confused is the whole point of this check:
 *
 *   - a FIRST schedule amortizes the original principal;
 *   - a REGENERATED schedule amortizes the outstanding balance at the moment of
 *     regeneration, which after a prepayment is NOT `principal - amountPaid`.
 *     The waterfall takes interest first, and on an interest-bearing loan
 *     `outstandingInterest` currently holds the whole LIFETIME interest, so most
 *     of a prepayment never reaches the principal at all. See the BUG? block on
 *     EMI-17 for the mechanism and the arithmetic.
 */
function assertScheduleSound(
  rows: ScheduleRow[],
  amortized: number,
  opts: { from?: number } = {},
): void {
  const from = opts.from ?? 1;
  expect(rows.length, 'the loan has no schedule at all').toBeGreaterThan(0);

  // 1..n with no gap (or startInstallmentNo..n after a regeneration). Both
  // `skip-installment` and the client guard address rows by this number.
  expect(
    rows.map((r) => r.installmentNo),
    'the instalment numbers are not a consecutive run',
  ).toEqual(rows.map((_, i) => from + i));

  // An EQUALITY, not an epsilon: the engine works in integer minor units, so
  // the components of a plan reconcile to the last unit or the plan is wrong.
  expect(
    sumMinor(rows.map((r) => r.principalComponent)),
    'the principal components do not sum to the amount being amortized',
  ).toBe(minor(amortized));

  expect(
    minor(rows[0].openingBalance),
    'the first instalment does not open on the full balance',
  ).toBe(minor(amortized));

  expect(
    minor(rows[rows.length - 1].closingBalance),
    'the final instalment leaves a balance behind',
  ).toBe(0);

  for (const row of rows) {
    expect(
      minor(row.emiAmount),
      `instalment ${row.installmentNo} has a non-positive EMI`,
    ).toBeGreaterThan(0);
  }

  for (let k = 1; k < rows.length; k++) {
    expect(
      minor(rows[k].openingBalance),
      `instalment ${rows[k].installmentNo} does not open where ${rows[k - 1].installmentNo} closed`,
    ).toBe(minor(rows[k - 1].closingBalance));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The importer, over HTTP
// ───────────────────────────────────────────────────────────────────────────

interface PreviewRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  data: Record<string, unknown>;
  derived?: { emi: number; totalInterest: number; nextDuePeriod: string | null };
}

interface PreviewResult {
  summary: { totalRows: number; validRows: number; invalidRows: number };
  rows: PreviewRow[];
}

/**
 * One import row, named rather than positional.
 *
 * The sheet is fourteen unlabelled columns in a fixed order and a shifted cell
 * is a silent wrong answer, so the columns are assembled in exactly one place.
 */
interface SheetRow {
  code?: string;
  ref: string;
  type?: 'LOAN' | 'ADVANCE';
  principal: number;
  method?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  rate?: number | '';
  installments: number;
  emi?: number | '';
  disbursedOn: string;
  firstPeriod: string;
  paid?: number;
  repaid?: number;
  status?: 'ACTIVE' | 'CLOSED' | 'ON_HOLD';
}

const cells = (r: SheetRow): unknown[] => [
  r.code ?? importSubject,
  r.ref,
  r.type ?? 'LOAN',
  r.principal,
  r.method ?? 'NONE',
  r.rate ?? '',
  r.installments,
  r.emi ?? '',
  r.disbursedOn,
  r.firstPeriod,
  r.paid ?? 0,
  r.repaid ?? 0,
  r.status ?? 'ACTIVE',
  // Lands on the loan's `reason`, which is how these are identified later.
  `${mark} — schedule maths`,
];

/** Built in memory: no fixture on disk to drift from the column contract. */
function workbook(rows: SheetRow[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...rows.map(cells)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Loans');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * A raw request context, because the import endpoints are multipart and the
 * shared `ApiClient` speaks JSON only. It carries the same bearer token, so it
 * is the same caller with the same permissions — only the encoding differs.
 */
async function withRawApi<T>(
  admin: ApiClient,
  fn: (ctx: import('@playwright/test').APIRequestContext) => Promise<T>,
): Promise<T> {
  const ctx = await newRequest.newContext({ baseURL: API_URL });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/** Phase one: parse and validate, persisting NOTHING. */
async function previewSheet(admin: ApiClient, rows: SheetRow[]): Promise<PreviewResult> {
  return withRawApi(admin, async (ctx) => {
    const res = await ctx.post('/advance-loans/import/preview', {
      headers: { Authorization: `Bearer ${admin.token}` },
      multipart: {
        file: { name: `${mark}.xlsx`, mimeType: XLSX_MIME, buffer: workbook(rows) },
      },
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`import preview failed: ${res.status()} ${text}`);
    const body = JSON.parse(text);
    // The service returns its own { success, ... } and the global interceptor
    // wraps responses too, so the depth of the nesting is not something a spec
    // should depend on.
    const payload = body?.data ?? body;
    return { summary: payload.summary, rows: payload.rows } as PreviewResult;
  });
}

/**
 * Does this sheet ask for interest?
 *
 * The importer refuses any non-NONE method while `loan_interest_enabled` is
 * off — regardless of rate, because a zero-rate FLAT still persists
 * `interestMethod: 'FLAT'` and every reader (the payoff quote, the
 * interest-earned report, the detail screen's Interest column) keys off that
 * field. Refusing rather than coercing is deliberate: an import REPRODUCES an
 * agreement whose opening balance and amount-repaid were computed WITH the
 * interest, so silently dropping it would leave the migrated loan owing a
 * different total than the ledger it came out of.
 */
const sheetCarriesInterest = (rows: SheetRow[]): boolean =>
  rows.some((r) => (r.method ?? 'NONE') !== 'NONE');

/**
 * Phase two: create only the rows preview called valid. Returns their ids.
 *
 * An interest-bearing sheet is imported with the kill-switch temporarily on.
 * The alternative — leaving each caller to remember — is what made four cases
 * in this file fail the moment the importer started honouring the switch.
 */
async function importLoans(admin: ApiClient, rows: SheetRow[]): Promise<string[]> {
  if (sheetCarriesInterest(rows)) {
    if (!flagFlipAllowed()) {
      throw new Error(
        'this sheet names an interest method, and the importer refuses those while ' +
          "loan_interest_enabled is 'false'. Re-run with E2E_ALLOW_FLAG_FLIP=1.",
      );
    }
    return withSettings(admin, { loan_interest_enabled: 'true' }, () =>
      importValidatedRows(admin, rows),
    );
  }
  return importValidatedRows(admin, rows);
}

async function importValidatedRows(admin: ApiClient, rows: SheetRow[]): Promise<string[]> {
  const preview = await previewSheet(admin, rows);
  const good = preview.rows.filter((r) => r.valid);
  expect(
    good.length,
    `the sheet did not validate: ${preview.rows.flatMap((r) => r.errors).join('; ')}`,
  ).toBe(rows.length);

  return withRawApi(admin, async (ctx) => {
    const res = await ctx.post('/advance-loans/import/confirm', {
      headers: {
        Authorization: `Bearer ${admin.token}`,
        'Content-Type': 'application/json',
      },
      data: { rows: good.map((r) => r.data) },
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`import confirm failed: ${res.status()} ${text}`);
    const payload = JSON.parse(text)?.data ?? JSON.parse(text);
    const results = (payload?.results ?? []) as Array<{
      success: boolean;
      loanId?: string;
      error?: string;
    }>;
    const failed = results.filter((r) => !r.success);
    expect(failed.map((f) => f.error).join('; '), 'a validated row failed to import').toBe('');
    return results.map((r) => r.loanId!).filter(Boolean);
  });
}

/** Yesterday: past enough to be legal, recent enough to need no maintenance. */
const disbursedOn = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** `YYYY-MM`, `n` whole months after the current one. */
function periodFromNow(monthsAhead: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The next January that has not started yet — the month-end anchor case. */
function nextJanuary(): string {
  const now = new Date();
  return `${now.getUTCFullYear() + 1}-01`;
}

/** The system setting as it stands, or null when the row does not exist. */
async function settingValue(api: ApiClient, key: string): Promise<string | null> {
  const rows = await api
    .get<Array<{ key: string; value: string }>>('/system-settings')
    .catch(() => [] as Array<{ key: string; value: string }>);
  return (Array.isArray(rows) ? rows : []).find((r) => r.key === key)?.value ?? null;
}

/**
 * How many columns the schedule table drew.
 *
 * The Interest column is rendered ONLY when the loan's method is not NONE, and
 * `LoanScheduleTable` gives its cells no test id of their own — so the presence
 * of the column is observable from the row's cell count and nothing else.
 * Counting cells is still structural: no visible text is matched.
 */
async function scheduleColumns(page: import('@playwright/test').Page): Promise<number> {
  const row = page.locator('[data-testid="loan-schedule-row"]').first();
  if (!(await row.count())) return 0;
  return row.locator('td').count();
}

const COLUMNS_WITHOUT_INTEREST = 6;
const COLUMNS_WITH_INTEREST = 7;

// ───────────────────────────────────────────────────────────────────────────
// §3 — the interest-free plan, which is every natively created loan
// ───────────────────────────────────────────────────────────────────────────

test.describe('an interest-free plan, from approval to the schedule table', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  /**
   * `note` becomes the loan's `reason` verbatim, and `reason` is the ONLY field
   * a sweep can identify this file's loans by — so the marker is prepended here
   * rather than at each of the seven call sites, and the stable half of it is
   * handed to the allowance sweep separately.
   */
  const track = async (opts: Parameters<typeof liveLoan>[2]): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, {
      ...opts,
      note: `${mark} — ${opts.note ?? 'schedule maths'}`,
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
      branchId = await branchIdByCode(adminApi, 'HO');
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
      test.skip(!isProject('admin'), 'the schedule is an ADMIN/HR surface');
    });

    test('EMI-01 an interest-free loan splits evenly and the LAST instalment absorbs the remainder', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // 200 over 3 does NOT divide: 20000 minor / 3 = 6666 each, and the last
      // row carries 6668. Picking an amount that divides cleanly would pass
      // whatever the code did with the remainder — including losing it.
      const id = await track({ amount: 200, installments: 3, note: 'even split' });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 200);
      expect(rows.length).toBe(3);

      const expected = splitLastAbsorbs(minor(200), 3);
      expect(expected).toEqual([6666, 6666, 6668]);
      expect(rows.map((r) => minor(r.principalComponent))).toEqual(expected);

      // The remainder lands entirely on the last row — 0.02 here — rather than
      // being spread, which is what guarantees the closing balance is exactly 0.
      const remainder = minor(200) - 3 * Math.floor(minor(200) / 3);
      expect(remainder).toBe(2);
      expect(
        minor(rows[2].emiAmount) - minor(rows[0].emiAmount),
        'the last instalment did not absorb exactly the remainder',
      ).toBe(remainder);

      // Interest-free means interest-free: no component, anywhere.
      expect(sumMinor(rows.map((r) => r.interestComponent))).toBe(0);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(3);

      // The Interest column is not drawn for a NONE loan. A column of zeros
      // would tell an employee their interest-free loan bears interest.
      expect(
        await scheduleColumns(page),
        'the schedule showed an Interest column on an interest-free loan',
      ).toBe(COLUMNS_WITHOUT_INTEREST);

      settle(problems, 'the schedule of an interest-free loan');
    });

    test('EMI-02 an ADVANCE is one instalment however many were asked for', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // Filed by hand rather than through `liveLoan`, which normalises the
      // count for an advance before it is sent — and the claim here is about
      // what the SERVER does with a count it was given.
      await ensureAllowance(employeeApi, adminApi, 200, MARKER_PREFIX);
      const created = await employeeApi.post<LoanRecord>('/advance-loans', {
        type: 'ADVANCE',
        amount: 200,
        installments: 6,
        reason: `${mark} — an advance asking for six instalments`,
      });
      scratch.push(created.id);
      await adminApi.post(`/advance-loans/${created.id}/approve`, {
        remarks: `${mark} approved`,
      });

      const loan = await loanRec(adminApi, created.id);
      expect(loan.type).toBe('ADVANCE');
      expect(loan.installments, 'an advance was spread over more than one cycle').toBe(1);

      // Both the request path and the engine force it, independently. The
      // schedule is the one that matters: it is what payroll recovers against.
      const rows = await scheduleOf(adminApi, created.id);
      expect(rows.length).toBe(1);
      assertScheduleSound(rows, 200);
      expect(minor(rows[0].emiAmount)).toBe(minor(200));
    });

    test('EMI-03 every MONTHLY due date is snapped to the last day of its month', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'due dates' });
      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 600);

      // `snapToCycle` exists because payroll is monthly: an instalment dated the
      // 12th belongs to that month's run, and dating it on the last day is what
      // makes `dueCycleKey <= cycle` a complete sweep rather than an off-by-one.
      for (const row of rows) {
        const due = asUTC(row.dueDate);
        expect(
          due.getUTCDate(),
          `instalment ${row.installmentNo} is due ${ymd(row.dueDate)}, which is not a month end`,
        ).toBe(lastDayOfMonth(due));
      }

      // 12 periods a year, visible as consecutive calendar months — the only
      // `periodsPerYear` any HTTP path in this module can produce (see EMI-18).
      const monthIndex = (row: ScheduleRow) => {
        const d = asUTC(row.dueDate);
        return d.getUTCFullYear() * 12 + d.getUTCMonth();
      };
      const first = monthIndex(rows[0]);
      expect(rows.map(monthIndex)).toEqual(rows.map((_, i) => first + i));
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §13 — interest, brought in the only way a rate can reach a loan
// ───────────────────────────────────────────────────────────────────────────

/**
 * The importer is not being tested here — `finance-loan-lifecycle.spec.ts` owns
 * the modal, the two-phase contract and the bad-row count. It is being USED, as
 * the single HTTP surface that can put an interest method and a rate onto a
 * loan, so that the FLAT and REDUCING_BALANCE plans can be checked as the
 * server persists them rather than only as pure functions.
 *
 * Every expectation below is recomputed in this file from the published formula
 * and compared to what came back. Reading the derived figure out of the API and
 * comparing it to itself would pass against any arithmetic at all.
 */
test.describe('interest, as the engine persists it', () => {
  let adminApi: ApiClient;
  let subject: TestEmployee | null = null;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  const importOne = async (row: SheetRow): Promise<string> => {
    const [id] = await importLoans(adminApi, [row]);
    expect(id, 'the import reported success but produced no loan').toBeTruthy();
    scratch.push(id);
    return id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      branchId = await branchIdByCode(adminApi, 'HO');
      // Made rather than borrowed: the import validator refuses a disbursement
      // dated before the employee joined, and `makeEmployee` starts its subjects
      // in 2020 — so any past date is legal, and no other spec is filing against
      // this code while these cases run.
      subject = await makeEmployee(adminApi, { marker: mark, branchId });
      importSubject = subject.code;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin')) return;
    // An imported loan arrives ACTIVE with a balance, so `retire` writes it off
    // rather than cancelling it — cancelling is for a request nobody approved.
    // Admin stands in for the owner because an API-created employee has no
    // usable login at all.
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && adminApi) {
      // The safety net for a crashed case, and for a crashed earlier run: scoped
      // to this file's marker, so it cannot touch a loan a sibling spec is
      // halfway through operating on.
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      if (subject) await terminateEmployee(adminApi, subject.id).catch(() => undefined);
    }
    await subject?.dispose();
    await adminApi?.dispose();
  });

  // Grouped so the role gate can live in a hook: a skip decided here runs
  // before the page fixture is built, so no browser window is opened only
  // to be thrown away.
  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'importing loans is an administrative flow');
    });

    test('EMI-04 FLAT charges one fixed total, split evenly with the last row absorbing', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await importOne({
        ref: nextRef(),
        principal: 1000,
        method: 'FLAT',
        rate: 7,
        installments: 6,
        disbursedOn,
        firstPeriod: periodFromNow(1),
      });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 1000);
      expect(rows.length).toBe(6);

      // Recomputed here: 1000 × 7% × (6/12) = 35.00 of interest, then BOTH the
      // principal and the interest split evenly with their own remainder pushed
      // onto the final row. Flat interest does not care about the balance, which
      // is the whole difference from reducing balance.
      const principalParts = splitLastAbsorbs(minor(1000), 6);
      const totalInterest = flatInterestMinor(minor(1000), 7, 6, 12);
      expect(totalInterest).toBe(3500);
      const interestParts = splitLastAbsorbs(totalInterest, 6);

      expect(rows.map((r) => minor(r.principalComponent))).toEqual(principalParts);
      expect(rows.map((r) => minor(r.interestComponent))).toEqual(interestParts);
      expect(rows.map((r) => minor(r.emiAmount))).toEqual(
        principalParts.map((p, i) => p + interestParts[i]),
      );

      // Every period bears the same interest — the property that separates FLAT
      // from REDUCING_BALANCE and the one an operator is choosing between.
      const distinct = new Set(rows.slice(0, 5).map((r) => minor(r.interestComponent)));
      expect(distinct.size, 'a FLAT plan charged different interest each period').toBe(1);

      expect(sumMinor(rows.map((r) => r.interestComponent))).toBe(totalInterest);
    });

    test('EMI-05 REDUCING_BALANCE charges interest on the live balance and the final row absorbs the residue', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await importOne({
        ref: nextRef(),
        principal: 1200,
        method: 'REDUCING_BALANCE',
        rate: 12,
        installments: 12,
        disbursedOn,
        firstPeriod: periodFromNow(1),
      });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 1200);
      expect(rows.length).toBe(12);

      // The annuity, computed from the formula rather than read back: 12% a year
      // over twelve monthly periods is 1% a period, so the level EMI is 106.62
      // and the final row is 106.60 — the residue landing where it can be
      // absorbed without leaving a balance.
      const plan = annuityPlan(minor(1200), 12, 12, 12);
      expect(plan.levelEmi).toBe(10662);

      expect(rows.map((r) => minor(r.interestComponent))).toEqual(plan.interest);
      expect(rows.map((r) => minor(r.principalComponent))).toEqual(plan.principal);
      expect(rows.map((r) => minor(r.emiAmount))).toEqual(plan.emi);

      // Interest on the LIVE balance: the first period is charged a full 1% of
      // 1200 and every period after it less, which is the whole difference from
      // the FLAT plan above. A method that quietly fell back to FLAT would still
      // reconcile — it would just cost the employee more.
      expect(minor(rows[0].interestComponent)).toBe(minor(12));
      for (let k = 1; k < rows.length; k++) {
        expect(
          minor(rows[k].interestComponent),
          `instalment ${rows[k].installmentNo} was charged more interest than the one before it`,
        ).toBeLessThan(minor(rows[k - 1].interestComponent));
      }

      // The loan carries the terms it was imported with; the payoff quote is
      // built from them, so a schedule that reconciles and a quote that does not
      // would still be a broken loan.
      const loan = await loanRec(adminApi, id);
      expect(loan.interestMethod).toBe('REDUCING_BALANCE');
      expect(Number(loan.interestRate)).toBe(12);
      expect(minor(loan.installmentAmount)).toBe(plan.levelEmi);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(12);

      // With a method other than NONE the table draws the Interest column, which
      // is the only place an employee can see what the loan actually costs.
      expect(
        await scheduleColumns(page),
        'the schedule hid the Interest column on an interest-bearing loan',
      ).toBe(COLUMNS_WITH_INTEREST);

      settle(problems, 'the schedule of a reducing-balance loan');
    });

    test('EMI-06 a zero rate produces a NONE plan even when the sheet names FLAT', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await importOne({
        ref: nextRef(),
        principal: 200,
        method: 'FLAT',
        rate: 0,
        installments: 3,
        disbursedOn,
        firstPeriod: periodFromNow(1),
      });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 200);

      // `generateSchedule` overrides the method to NONE when the rate is zero,
      // so the plan is byte-for-byte the interest-free split of EMI-01 rather
      // than a FLAT plan that happens to charge nothing.
      expect(rows.map((r) => minor(r.principalComponent))).toEqual(
        splitLastAbsorbs(minor(200), 3),
      );
      expect(sumMinor(rows.map((r) => r.interestComponent))).toBe(0);

      // The RECORD still says FLAT, because the override happens inside the
      // engine and is never written back. The detail screen keys the Interest
      // column off the record, so a zero-rate FLAT loan shows the column with
      // nothing in it — accurate, if not obviously useful.
      const loan = await loanRec(adminApi, id);
      expect(loan.interestMethod).toBe('FLAT');
      expect(Number(loan.interestRate)).toBe(0);
    });

    test('EMI-07 a 100% rate still reconciles, and a rate that can never amortize is refused', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // 100 is the importer's ceiling and the engine's documented extreme. At
      // 1% a period it is arithmetically ordinary; at 100 it is where an
      // overflow or a negative principal would show up first.
      const id = await importOne({
        ref: nextRef(),
        principal: 1200,
        method: 'REDUCING_BALANCE',
        rate: 100,
        installments: 12,
        disbursedOn,
        firstPeriod: periodFromNow(1),
      });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 1200);
      const plan = annuityPlan(minor(1200), 100, 12, 12);
      expect(rows.map((r) => minor(r.principalComponent))).toEqual(plan.principal);
      expect(rows.map((r) => minor(r.interestComponent))).toEqual(plan.interest);
      // Even here every instalment repays SOME principal; the balance falls.
      expect(minor(rows[0].closingBalance)).toBeLessThan(minor(1200));

      // The other end: terms under which the level EMI does not cover the first
      // period's interest, so the balance would grow forever. 12.07 at 100% over
      // 60 periods rounds the annuity and the interest to the same 1.01, leaving
      // nothing for principal — and the engine refuses rather than persisting a
      // loan that can never be repaid.
      //
      // `previewSheet` is called directly here rather than through
      // `importLoans`, so the interest kill-switch has to be opened by hand:
      // the importer refuses ANY non-NONE method while it is off, and that
      // refusal would land before the engine ever got to complain about the
      // rate — hiding the sentence this case exists to assert.
      test.skip(!flagFlipAllowed(), 'an interest-bearing sheet needs loan_interest_enabled on');
      const preview = await withSettings(adminApi, { loan_interest_enabled: 'true' }, () =>
        previewSheet(adminApi, [
          {
            ref: nextRef(),
            principal: 12.07,
            method: 'REDUCING_BALANCE',
            rate: 100,
            installments: 60,
            disbursedOn,
            firstPeriod: periodFromNow(1),
          },
        ]),
      );

      expect(preview.summary.validRows, 'a loan that can never amortize was accepted').toBe(0);
      expect(preview.summary.invalidRows).toBe(1);
      // The engine's own sentence, all the way to the operator. A generic
      // "could not build a schedule" would leave them with no idea which of the
      // rate and the tenure to change.
      expect(preview.rows[0].errors.join(' | ')).toContain(
        'Interest exceeds the level EMI',
      );
      expect(preview.rows[0].errors.join(' | ')).toContain('Reduce the rate');
    });

    test('EMI-08 month-end anchoring: two periods after 31 January is 31 March, not 28 February plus a month', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The importer's first due date is the last day of the first deduction
      // month, so a January period anchors the whole plan on the 31st.
      const january = nextJanuary();
      const id = await importOne({
        ref: nextRef(),
        principal: 1200,
        installments: 4,
        disbursedOn,
        firstPeriod: january,
      });

      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, 1200);
      const year = Number(january.slice(0, 4));

      // Every due date is computed from the ANCHOR, not by walking a month on
      // from the previous result. Walking would give 31 Jan → 28 Feb → 28 Mar
      // and the plan would sit three days early for the rest of its life.
      expect(ymd(rows[0].dueDate)).toBe(`${year}-01-31`);
      const february = new Date(Date.UTC(year, 1, 1));
      expect(ymd(rows[1].dueDate)).toBe(
        `${year}-02-${String(lastDayOfMonth(february)).padStart(2, '0')}`,
      );
      expect(
        ymd(rows[2].dueDate),
        'the schedule drifted: February became the anchor instead of January',
      ).toBe(`${year}-03-31`);
      expect(ymd(rows[2].dueDate)).not.toBe(`${year}-03-28`);
      expect(ymd(rows[3].dueDate)).toBe(`${year}-04-30`);
    });

    test('EMI-09 an imported mid-life loan keeps its paid rows and amortizes only what is left', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await importOne({
        ref: nextRef(),
        principal: 1200,
        installments: 12,
        paid: 3,
        repaid: 300,
        disbursedOn,
        firstPeriod: periodFromNow(1),
      });

      const rows = await scheduleOf(adminApi, id);
      // The plan is the WHOLE loan — the consumed instalments are retained as
      // history rather than trimmed, which is what lets a reader see what was
      // already paid instead of a twelve-month loan that starts at nine.
      expect(rows.length).toBe(12);
      assertScheduleSound(rows, 1200);

      expect(rows.slice(0, 3).map((r) => r.status)).toEqual(['PAID', 'PAID', 'PAID']);
      expect(rows.slice(3).every((r) => r.status === 'SCHEDULED')).toBe(true);

      // What is still owed is amortized by the still-scheduled rows and by
      // nothing else: 900 across nine instalments of 100.
      expect(sumMinor(rows.slice(3).map((r) => r.principalComponent))).toBe(minor(900));
      expect(minor(rows[2].closingBalance)).toBe(minor(900));
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(900);

      const loan = await loanRec(adminApi, id);
      expect(Number(loan.amountRepaid)).toBe(300);

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(12);
      expect(await detail.scheduleRowStatus(1)).toBe('PAID');
      expect(await detail.scheduleRowStatus(4)).toBe('SCHEDULED');

      settle(problems, 'the schedule of an imported mid-life loan');
    });

    test('EMI-10 the interest kill-switch governs the importer as well as the native path', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const flag = await settingValue(adminApi, 'loan_interest_enabled');
      test.skip(
        flag !== null && flag !== 'false',
        `loan_interest_enabled is '${flag}', so the switched-off behaviour is not observable here`,
      );

      // Off — the default, and what the e2e baseline runs with. The importer
      // used to ignore the switch entirely and call `generateSchedule` with the
      // sheet's own method and rate, so a migration could introduce
      // interest-bearing loans into a deployment that had interest switched
      // off. It refuses now, rather than coercing to NONE: an import
      // REPRODUCES an agreement whose opening balance and amount-repaid were
      // computed WITH the interest, so silently dropping it would leave the
      // migrated loan owing a different total than the ledger it came from.
      const refusal = await previewSheet(adminApi, [
        {
          ref: nextRef(),
          principal: 1200,
          method: 'FLAT',
          rate: 12,
          installments: 12,
          disbursedOn,
          firstPeriod: periodFromNow(1),
        },
      ]);
      expect(refusal.summary.validRows, 'an interest-bearing row was accepted').toBe(0);
      expect(refusal.rows[0].errors.join(' | ')).toContain(
        'Interest is switched off in this system, so a loan with Interest Method FLAT cannot be imported.',
      );

      // Regardless of RATE — a zero-rate FLAT is still refused, because the row
      // would persist `interestMethod: 'FLAT'` and every reader keys off that
      // field, not off the rate.
      const zeroRate = await previewSheet(adminApi, [
        {
          ref: nextRef(),
          principal: 1200,
          method: 'FLAT',
          rate: 0,
          installments: 12,
          disbursedOn,
          firstPeriod: periodFromNow(1),
        },
      ]);
      expect(zeroRate.summary.validRows, 'a zero-rate FLAT row was accepted').toBe(0);

      // The native path, on the same setting: `LoanScheduleService.generate`
      // forces NONE and a zero rate, so a natively approved loan bears nothing.
      // Both doors now answer to the same switch — by refusal on one, by
      // coercion on the other, for the reason above.
      const employeeApi = await ApiClient.as('employee');
      try {
        const nativeId = await liveLoan(employeeApi, adminApi, {
          amount: 600,
          installments: 6,
          note: `${mark} — kill-switch control`,
          markerPrefix: MARKER_PREFIX,
        });
        try {
          const native = await loanRec(adminApi, nativeId);
          expect(native.interestMethod).toBe('NONE');
          expect(Number(native.interestRate)).toBe(0);
          expect(sumMinor((await scheduleOf(adminApi, nativeId)).map((r) => r.interestComponent)))
            .toBe(0);
        } finally {
          await retire(nativeId, employeeApi, adminApi);
        }
      } finally {
        await employeeApi.dispose();
      }
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Regeneration — the plan being rebuilt from what is STILL owed
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every regeneration re-amortizes the OUTSTANDING balance, never the original
 * principal. That distinction is the requirement doc's "loan is edited after
 * some EMIs have already been deducted" case and it is where a schedule most
 * easily starts disagreeing with the ledger it is supposed to describe.
 *
 * These run on interest-free loans on purpose: with `loan_interest_enabled` off
 * a regeneration drops to NONE whatever the loan says, so putting an imported
 * rate through one would assert the kill-switch rather than the re-amortization.
 * The rate half is in the gated describe below, where the switch can be moved.
 */
test.describe('regeneration re-amortizes what is still owed', () => {
  let employeeApi: ApiClient;
  let adminApi: ApiClient;
  let branchId = '';
  let setupError = '';
  let scratch: string[] = [];

  /**
   * `note` becomes the loan's `reason` verbatim, and `reason` is the ONLY field
   * a sweep can identify this file's loans by — so the marker is prepended here
   * rather than at each of the seven call sites, and the stable half of it is
   * handed to the allowance sweep separately.
   */
  const track = async (opts: Parameters<typeof liveLoan>[2]): Promise<string> => {
    const id = await liveLoan(employeeApi, adminApi, {
      ...opts,
      note: `${mark} — ${opts.note ?? 'schedule maths'}`,
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
      branchId = await branchIdByCode(adminApi, 'HO');
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
    // The safety net for a case that crashed between filing a loan and retiring
    // it, and for a crashed earlier run. Scoped to this file's marker, so it
    // cannot touch a loan a sibling spec is halfway through operating on.
    if (isProject('admin') && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
    }
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

    test('EMI-11 REDUCE_TENURE drops instalments off the tail and holds the instalment amount', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'reduce tenure' });
      const before = await loanRec(adminApi, id);
      expect(minor(before.installmentAmount)).toBe(minor(100));
      const versionBefore = before.scheduleVersion ?? 1;

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(6);

      // Driven from the dialog, because the recalculation mode is a choice the
      // operator makes there and a spec that only posted JSON would not notice
      // the select disappearing.
      await detail.run('prepay', {
        amount: '200',
        mode: 'BANK',
        reference: `${mark}-utr`,
        recalc: 'REDUCE_TENURE',
      });

      // 400 still owed at an unchanged 100 a cycle is four instalments.
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(4);

      const rows = await scheduleOf(adminApi, id);
      // The new plan amortizes 400 — what is LEFT — not the 600 that was
      // borrowed. Re-amortizing the principal is the classic double-charge.
      assertScheduleSound(rows, 400);
      expect(rows.every((r) => minor(r.emiAmount) === minor(100))).toBe(true);

      const after = await loanRec(adminApi, id);
      expect(
        minor(after.installmentAmount),
        'REDUCE_TENURE changed the instalment as well as the count',
      ).toBe(minor(100));
      expect(
        after.scheduleVersion ?? 1,
        'the schedule was rebuilt without bumping its version',
      ).toBe(versionBefore + 1);
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(400);

      settle(problems, 'a prepayment that shortens the tenure');
    });

    test('EMI-12 REDUCE_EMI holds the count and shrinks the instalment', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'reduce emi' });
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 150,
        mode: 'CASH',
        recalc: 'REDUCE_EMI',
      });

      const rows = await scheduleOf(adminApi, id);
      expect(rows.length, 'REDUCE_EMI shortened the loan instead of lowering the instalment').toBe(6);
      // 450 over the same six cycles is 75 each — and it reconciles exactly,
      // which is the property that a naive `round(balance / n)` loses.
      assertScheduleSound(rows, 450);
      expect(rows.map((r) => minor(r.emiAmount))).toEqual(splitLastAbsorbs(minor(450), 6));

      const after = await loanRec(adminApi, id);
      expect(minor(after.installmentAmount)).toBe(minor(75));
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(450);
    });

    test('EMI-13 skipping an instalment with EXTEND rebuilds the plan at a new version', async ({
      page,
      problems,
    }) => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      const id = await track({ amount: 600, installments: 6, note: 'skip extend' });
      const versionBefore = (await loanRec(adminApi, id)).scheduleVersion ?? 1;

      await selectBranch(page, branchId);
      const detail = new LoanLifecyclePage(page);
      await detail.open(id);
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(6);

      await detail.run('skip', {
        'installment-no': '4',
        mode: 'EXTEND',
        reason: `${mark} instalment deferred, the debt is still owed`,
      });

      // EXTEND lengthens the plan by exactly the instalment it moved out, so the
      // amount deducted each cycle is unchanged and the loan simply ends a cycle
      // later. `regenerate` used to compute the remaining count as
      // `installments - highestSettledNo` — marking #4 SKIPPED made that 6-4=2,
      // and the whole 600 was re-amortized over two instalments of 300. The
      // operation whose entire purpose is to move ONE instalment out tripled the
      // employee's next deduction instead.
      await expect.poll(() => detail.scheduleRowCount(), { timeout: 15_000 }).toBe(6);

      const rows = await scheduleOf(adminApi, id);
      // The instalment amount is the point: unchanged at 100, not 300.
      for (const row of rows) {
        expect(row.emiAmount, 'EXTEND changed what is deducted each cycle').toBeCloseTo(100, 2);
      }
      // Numbering CONTINUES from the settled row rather than restarting: the new
      // rows are #5 through #10, so nothing on the live schedule collides with
      // an instalment number that has already been settled.
      assertScheduleSound(rows, 600, { from: 5 });

      const after = await loanRec(adminApi, id);
      expect(after.scheduleVersion ?? 1).toBe(versionBefore + 1);

      // Only rows at the CURRENT version are live. The superseded ones are kept
      // in the database as CANCELLED with a `supersededAt` — that is the audit
      // trail for "the schedule was rebuilt" — but no HTTP route exposes an
      // older version, so what is assertable from here is that the live view
      // shows the new rows and none of the old ones.
      expect(await detail.scheduleRowStatus(1)).toBeNull();
      expect(
        await detail.scheduleRowStatus(4),
        'the skipped instalment is still being shown as live',
      ).toBeNull();
      expect(await detail.scheduleRowStatus(5)).toBe('SCHEDULED');

      settle(problems, 'a schedule rebuilt after a skipped instalment');
    });

    test('EMI-14 regression: a rebuilt schedule never re-charges the instalment it superseded', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');

      // The named regression. `regenerate` deliberately folds NO opening arrears
      // into the new plan: the unpaid part of a skipped or partial row was never
      // credited to `amountRepaid`, so it is still inside the outstanding
      // balance the new schedule amortizes. Adding it to instalment #1 as an
      // arrear — which reads like the obvious thing to do — demands it twice,
      // and for a waived row resurrects a debt the employer forgave.
      const id = await track({ amount: 600, installments: 6, note: 'no arrears' });

      await adminApi.post(`/advance-loans/${id}/skip-installment`, {
        installmentNo: 4,
        mode: 'EXTEND',
        reason: `${mark} instalment deferred, still owed`,
      });

      const rows = await scheduleOf(adminApi, id);
      // Exactly the outstanding balance, to the unit. 700 would be the
      // double-charge: 600 still owed plus the 100 of the skipped instalment.
      expect(
        sumMinor(rows.map((r) => r.emiAmount)),
        'the skipped instalment was charged a second time as an opening arrear',
      ).toBe(minor(600));
      expect(sumMinor(rows.map((r) => r.principalComponent))).toBe(minor(600));

      // The arrear, had it been folded in, would land on the FIRST row of the
      // new plan and nowhere else — so an even first instalment is the proof.
      expect(minor(rows[0].emiAmount)).toBe(minor(rows[rows.length - 1].emiAmount));
      expect((await quoteOf(adminApi, id)).outstandingPrincipal).toBe(600);
    });

    test('EMI-15 regeneration is refused while an unlocked payroll holds an instalment', async () => {
      test.skip(
        true,
        'reaching this state means generating a payroll run, which is per-BRANCH and ' +
          'attaches a PENDING deduction to every live loan in the branch — including the ' +
          'loans the sibling specs running concurrently are halfway through operating on. ' +
          'payroll-depth.spec.ts owns run generation; the refusal it produces is quoted by ' +
          'LoanLifecyclePage.run() so contention is one line to tell apart from a real break.',
      );
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The settings that change the arithmetic
// ───────────────────────────────────────────────────────────────────────────

/**
 * `loan_interest_enabled` is environment-wide configuration: turned on, it
 * changes the plan every other suite is asserting on. So this describe only runs
 * when the harness has been told that flipping is allowed, and it is still
 * COLLECTED by a default run so it reports "skipped, and here is why" rather
 * than vanishing.
 *
 * The switch is only observable on a loan that HAS a rate, and only at a
 * regeneration: `LoanScheduleService.generate` reads it at approval, when no
 * natively created loan has a method to keep, and the importer does not read it
 * at all. So both cases here import a reducing-balance loan and then make it
 * regenerate — which is also the one code path that passes `loan_rounding_unit`
 * into the engine, and the reason EMI-16 lives here even though it cannot run.
 */
test.describe('the interest switch, which changes the plan itself', () => {
  const allowed = flagFlipAllowed();

  let adminApi: ApiClient;
  let subject: TestEmployee | null = null;
  let setupError = '';
  let scratch: string[] = [];

  const importOne = async (row: SheetRow): Promise<string> => {
    const [id] = await importLoans(adminApi, [row]);
    scratch.push(id);
    return id;
  };

  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'these settings are administrative');
    test.skip(
      !allowed,
      'flipping loan_interest_enabled changes the plan every other suite asserts on — ' +
        'run with the flag-flip harness (E2E_ALLOW_FLAG_FLIP=1, own database)',
    );
  });

  test.beforeAll(async () => {
    if (!isProject('admin') || !allowed) return;
    try {
      adminApi = await ApiClient.as('admin');
      // Its own subject rather than the one the describe above made: these cases
      // only run under a different harness invocation, so nothing guarantees the
      // other describe's `beforeAll` ever executed.
      subject = await makeEmployee(adminApi, { marker: `${mark}f` });
      importSubject = subject.code;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin') || !allowed) return;
    for (const id of scratch) await retire(id, adminApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (isProject('admin') && allowed && adminApi) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      if (subject) await terminateEmployee(adminApi, subject.id).catch(() => undefined);
    }
    await subject?.dispose();
    await adminApi?.dispose();
  });

  test('EMI-16 a whole-unit rounding unit rounds the EMI and the last row still absorbs', async () => {
    test.skip(
      true,
      'loan_rounding_unit cannot be flipped safely from a spec. POST /system-settings ' +
        'WOULD write it — the write path upserts arbitrary keys — but ' +
        'SystemSettingsService.getSettingsList() does not enumerate it, so GET /system-settings ' +
        'never returns it and its current value cannot be read. withSetting therefore refuses ' +
        'the key rather than restoring a guessed default, and a rounding unit left at 1 would ' +
        'change every reducing-balance plan in the run. The fix is one line in ' +
        'getSettingsList(); until then the whole-unit case is covered in ' +
        'loan-amortization.util.spec.ts, where the parameter is passed directly. ' +
        '(loan_grace_period_cycles and loan_deferral_mode are unreadable for the same reason.)',
    );
  });

  // BUG?: prepaying an interest-bearing loan makes it MORE expensive, because
  // the whole LIFETIME interest is treated as due on day one and is then
  // charged again over the same calendar by the regeneration that the
  // prepayment triggers.
  //
  // Where it comes from:
  //   - `loan-schedule.service.ts:197` (and `loan-import.service.ts:423`)
  //     initialise `outstandingInterest` to the loan's ENTIRE scheduled
  //     lifetime interest at creation, not to interest ACCRUED to date.
  //   - `loan-lifecycle.service.ts:242` reads that straight back as
  //     `interestDue`, and :251-255 runs the interest-before-principal
  //     waterfall against it — so a prepayment made on day one is swallowed by
  //     twelve months of not-yet-accrued interest.
  //   - `loan-schedule.service.ts:361` (`regenerate`) then RESETS
  //     `outstandingInterest` to the NEW schedule's total interest, with no
  //     credit for the interest just collected. The same months are charged
  //     twice.
  //
  // For this loan — 1200.00, REDUCING_BALANCE at 12%, 12 monthly instalments,
  // lifetime interest 79.42:
  //
  //   prepay 200.00 -> interest 79.42, principal   120.58
  //   outstanding   -> 1200.00 - 120.58         = 1079.42   <- amortized next
  //   regenerate    -> re-amortizes 1079.42, charging a NEW 71.43 interest
  //
  //   total interest 79.42 -> 150.85     total outlay 1279.42 -> 1350.85
  //
  // i.e. paying 200.00 off a 1200.00 loan raises what the employee owes in
  // total by 71.43. The amortizer is INNOCENT: `sum(principalComponent)` is
  // exactly the balance it was handed (1079.42) and `generateSchedule` asserts
  // that internally. Only the balance handed to it is wrong.
  //
  // House rule is to assert what the product DOES, so the numbers below are
  // the wrong ones, pinned exactly. The day `outstandingInterest` becomes
  // accrued-to-date interest, every number in this test goes RED and must be
  // rewritten to 1000.00 / 900.00 deliberately — which is the point.
  test('EMI-17 a prepayment reaches the principal, and interest is never charged twice', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const id = await importOne({
      ref: nextRef(),
      principal: 1200,
      method: 'REDUCING_BALANCE',
      rate: 12,
      installments: 12,
      disbursedOn,
      firstPeriod: periodFromNow(1),
    });

    // The plan's LIFETIME interest — what the loan will cost if it simply runs
    // to term. It is a property of the plan, not a debt: nothing is owed until
    // an instalment falls due, and this loan's first one is next month.
    const LIFETIME_INTEREST = 79.42;
    expect(
      sumMinor((await scheduleOf(adminApi, id)).map((r) => r.interestComponent)),
      'the imported plan is not the 1200 @ 12%/12 annuity this case is built on',
    ).toBe(minor(LIFETIME_INTEREST));

    // NOTHING is owed in interest on day one, and the payoff is bare principal.
    //
    // This is the fix. `outstandingInterest` used to be initialised to the
    // lifetime figure at creation, and `prepay` read it as "interest due" and
    // ran its interest-first waterfall against it — so a payment made before a
    // single instalment had fallen due was swallowed by twelve months of
    // unearned interest, and the regeneration that followed charged the same
    // months again. On this loan, paying 200 early took the total cost from
    // 1279.42 to 1350.85: the borrower handed over 200 and their principal fell
    // by 120.58. It is now accrued-and-unpaid interest over instalments already
    // due, derived from the live schedule rather than cached.
    const opening = await quoteOf(adminApi, id);
    expect(
      minor(opening.outstandingInterest),
      'interest is owed before any instalment has fallen due',
    ).toBe(0);
    expect(minor(opening.outstandingPrincipal)).toBe(minor(1200));
    expect(minor(opening.payoffAmount), 'the payoff quote includes unearned interest').toBe(
      minor(1200),
    );

    // 200.00 of principal, all of it. Not 120.58.
    const AFTER_FIRST_PREPAY = 1000.0;

    await withSettings(adminApi, { loan_interest_enabled: 'true' }, async () => {
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 200,
        mode: 'CASH',
        recalc: 'REDUCE_EMI',
      });
      const rows = await scheduleOf(adminApi, id);
      expect(rows.length, 'REDUCE_EMI changed the instalment count').toBe(12);
      assertScheduleSound(rows, AFTER_FIRST_PREPAY);

      // Still a reducing-balance plan: the rebuilt rows bear interest on the
      // remaining balance, computed here from the formula rather than read back.
      const plan = annuityPlan(minor(AFTER_FIRST_PREPAY), 12, 12, 12);
      expect(rows.map((r) => minor(r.interestComponent))).toEqual(plan.interest);

      // The rebuilt plan's interest is LOWER than the original, which is the
      // whole point of paying early: 66.19 over the remaining 1000 rather than
      // 79.42 over the original 1200. Total cost 1266.19 against 1279.42 for
      // never prepaying — the borrower is 13.23 better off.
      expect(
        sumMinor(rows.map((r) => r.interestComponent)),
        'the rebuilt plan does not price the reduced balance',
      ).toBe(minor(66.19));

      const quote = await quoteOf(adminApi, id);
      expect(
        minor(quote.outstandingPrincipal),
        'the prepayment did not reach the principal in full',
      ).toBe(minor(AFTER_FIRST_PREPAY));
      // Still nothing ACCRUED — the first instalment has yet to fall due.
      expect(minor(quote.outstandingInterest)).toBe(0);
      expect(minor(quote.payoffAmount)).toBe(minor(AFTER_FIRST_PREPAY));
    });

    // A second payment, with the kill-switch off. Again all principal.
    const AFTER_SECOND_PREPAY = 900.0;

    await withSettings(adminApi, { loan_interest_enabled: 'false' }, async () => {
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 100,
        mode: 'CASH',
        recalc: 'REDUCE_EMI',
      });
      const rows = await scheduleOf(adminApi, id);
      assertScheduleSound(rows, AFTER_SECOND_PREPAY);

      // With the switch off the SAME loan regenerates as interest-free. The
      // record still says REDUCING_BALANCE at 12%, so the detail screen keeps
      // drawing an Interest column — of zeros.
      expect(
        sumMinor(rows.map((r) => r.interestComponent)),
        'interest survived a regeneration made with the kill-switch off',
      ).toBe(0);
      expect(rows.map((r) => minor(r.principalComponent))).toEqual(
        splitLastAbsorbs(minor(AFTER_SECOND_PREPAY), rows.length),
      );

      const quote = await quoteOf(adminApi, id);
      expect(
        minor(quote.outstandingPrincipal),
        'the second prepayment did not reach the principal in full',
      ).toBe(minor(AFTER_SECOND_PREPAY));
      expect(minor(quote.outstandingInterest)).toBe(0);

      const loan = await loanRec(adminApi, id);
      expect(loan.interestMethod).toBe('REDUCING_BALANCE');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The engine inputs that finally have a door
// ───────────────────────────────────────────────────────────────────────────

/**
 * This block used to assert the OPPOSITE, and was right to.
 *
 * The engine has always supported WEEKLY (52 periods a year), QUARTERLY (4) and
 * a grace period that shifts the first due date, and none of the three could be
 * reached: the import sheet was fourteen fixed columns with no frequency among
 * them, the importer hard-coded MONTHLY, and no DTO in the module carried a
 * frequency or a grace count. The old EMI-18 pinned that — "every reachable
 * path produces a MONTHLY plan with no grace" — and its failure the day a
 * fifteenth column appeared is the pin doing its job.
 *
 * What it asserts now is the same claim inverted: the doors exist, and what
 * comes through them reaches the schedule.
 */
test.describe('the frequency and grace inputs have a door at last', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'reads the import contract and an approved loan');
  });

  test('EMI-18 the sheet, the DTO and the schedule all carry the cadence', async () => {
    const adminApi = await ApiClient.as('admin');
    const employeeApi = await ApiClient.as('employee');
    let loanId = '';
    let quarterlyId = '';
    try {
      // The template IS the contract the operator is handed, and the frequency
      // column is now part of it.
      const headers = await withRawApi(adminApi, async (ctx) => {
        const res = await ctx.get('/advance-loans/import/template', {
          headers: { Authorization: `Bearer ${adminApi.token}` },
        });
        expect(res.ok(), `the template download failed: ${res.status()}`).toBe(true);
        const wb = XLSX.read(await res.body(), { type: 'buffer' });
        const ws = wb.Sheets['Loans'] ?? wb.Sheets[wb.SheetNames[0]];
        const grid = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
        return (grid[0] ?? []).map((h) => String(h));
      });

      expect(headers).toEqual(IMPORT_HEADERS);
      expect(
        headers.filter((h) => /frequency/i.test(h)),
        'the import sheet lost the frequency column again',
      ).toHaveLength(1);

      // Omitting the cadence still means MONTHLY, so every sheet and every
      // caller that predates the column keeps meaning what it did.
      loanId = await liveLoan(employeeApi, adminApi, {
        amount: 600,
        installments: 6,
        note: `${mark} — default cadence`,
        markerPrefix: MARKER_PREFIX,
      });
      const loan = await loanRec(adminApi, loanId);
      expect(loan.deductionFrequency, 'the default cadence stopped being MONTHLY').toBe(
        'MONTHLY',
      );
      expect(loan.gracePeriods ?? 0).toBe(0);

      const rows = await scheduleOf(adminApi, loanId);
      const first = asUTC(rows[0].dueDate);
      const now = new Date();
      const monthsOut =
        (first.getUTCFullYear() - now.getUTCFullYear()) * 12 +
        (first.getUTCMonth() - now.getUTCMonth());
      expect(monthsOut, 'the first instalment was pushed out with no grace asked for')
        .toBeLessThanOrEqual(1);

      // And asking for a quarterly plan with grace produces one. The gap between
      // the first two due dates is what the cadence MEANS, so that is what is
      // measured rather than the column being echoed back.
      // Room made first: `loan_max_active_per_employee` is 2 and the default-
      // cadence loan above already holds one slot, so on a database that has
      // run this suite before the filing is refused by the cap rather than by
      // anything this case is about. Filed by hand rather than through
      // `liveLoan` because the cadence fields are the point.
      await ensureAllowance(employeeApi, adminApi, 1200, MARKER_PREFIX);
      const filed = await employeeApi.post<any>('/advance-loans', {
        type: 'LOAN',
        amount: 1200,
        installments: 4,
        deductionFrequency: 'QUARTERLY',
        gracePeriods: 2,
        reason: `${mark} — quarterly with grace`,
      });
      quarterlyId = filed?.id ?? filed?.data?.id;
      await adminApi.post(`/advance-loans/${quarterlyId}/approve`, {});

      const quarterly = await loanRec(adminApi, quarterlyId);
      expect(quarterly.deductionFrequency).toBe('QUARTERLY');
      expect(quarterly.gracePeriods).toBe(2);

      const qRows = await scheduleOf(adminApi, quarterlyId);
      expect(qRows.length).toBe(4);
      const gapDays =
        (asUTC(qRows[1].dueDate).getTime() - asUTC(qRows[0].dueDate).getTime()) / 86_400_000;
      expect(gapDays, 'a quarterly plan is still being scheduled monthly').toBeGreaterThan(80);

      // The grace shifts the first instalment out; without it the first is due
      // in the next cycle.
      const qMonthsOut =
        (asUTC(qRows[0].dueDate).getUTCFullYear() - now.getUTCFullYear()) * 12 +
        (asUTC(qRows[0].dueDate).getUTCMonth() - now.getUTCMonth());
      expect(qMonthsOut, 'the grace period did not move the first instalment').toBeGreaterThan(
        monthsOut,
      );
    } finally {
      if (quarterlyId) await retire(quarterlyId, employeeApi, adminApi).catch(() => undefined);
      if (loanId) await retire(loanId, employeeApi, adminApi);
      await employeeApi.dispose();
      await adminApi.dispose();
    }
  });
});
