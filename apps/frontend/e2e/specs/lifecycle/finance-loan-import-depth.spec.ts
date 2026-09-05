import * as XLSX from 'xlsx';
import { request } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import {
  test,
  expect,
  settle,
  ApiClient,
  watchForProblems,
  assertNoCrashes,
} from '../../fixtures';
import { API_URL, FRONTEND_URL, STORAGE_DIR } from '../../playwright.config';
import { LoanImportModalPage, selectBranch } from '../../pages/loan-lifecycle';
import {
  branchIdByCode,
  deductionsFor,
  loanOf,
  marker,
  quoteOf,
  retireAllMarked,
  scheduleOf,
} from '../../loan-support';

/**
 * The loan importer, past the one happy path.
 *
 * `finance-loan-lifecycle.spec.ts` already owns the journey — a template
 * downloads, a two-row sheet previews with its bad row counted, confirm creates
 * the good one. Everything here is what that test deliberately does not reach,
 * and the surface is worth the depth because an importer is the ONE door in this
 * module through which a loan enters the ledger without a human ever approving
 * it. `approvalSource: 'IMPORT'`, `status` straight from the spreadsheet cell,
 * a DISBURSEMENT transaction and PAID history rows written on the operator's
 * word alone. Every guard on that door is a spreadsheet validation, and a
 * spreadsheet validation that is not asserted is a guard nobody is holding.
 *
 * ## Why so much of this is driven over the API rather than through the modal
 *
 * Three reasons, all of them about what the screen can and cannot say:
 *
 *   1. **The per-row issue is rendered as bare text.** `LoanImportModal.tsx`
 *      draws `r.errors.map(...)` into an undecorated `<div>` — no test id, no
 *      data attribute. The house rule here is `data-testid` only, never visible
 *      text, so the ONLY honest way to assert "row 14 was refused for THIS
 *      reason" is the preview response itself. The modal is still driven, on the
 *      same workbook, for the thing it can answer: `data-count` on
 *      `loan-import-rows|valid|invalid`.
 *
 *   2. **A refused FILE never reaches the preview step at all.** A `.csv`, an
 *      oversized upload or a buffer that is not a workbook comes back 4xx/5xx,
 *      the modal toasts and stays on `UPLOAD`, and `LoanImportModalPage.choose`
 *      — which polls for `PREVIEW` — would spend thirty seconds proving nothing.
 *      The status code IS the assertion, so those cases are made where the
 *      status code exists.
 *
 *   3. **The size cap cannot be reached through a file picker.** 2,000 rows is
 *      the DTO's `@ArrayMaxSize`, not the sheet's; it is a property of
 *      `POST /advance-loans/import/confirm` and is asserted there.
 *
 * ## The marker, and why cleanup uses a sweep
 *
 * One confirm can create many loans, and a case that fails halfway leaves an
 * unknown number of them. Every row this file writes therefore carries
 * `MARKER_PREFIX` in its **Notes** column, which the importer stores as the
 * loan's `reason` (`reason: row.notes || 'Imported'`), and `afterAll` retires
 * everything wearing it rather than a list of ids it hoped it kept.
 *
 * ## Subjects
 *
 * `EMP002` (`employee2@company.com`, joined 2025-01-01) for everything the
 * importer is meant to do — the same subject the existing importer test uses, so
 * the two files cannot contend with a third. `MGR001` appears exactly once, in
 * the unvalidated-confirm probe, because the whole point of that probe is that
 * confirm will create a loan for an employee no preview ever looked at.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half of the marker — what identifies a loan as THIS FILE'S. */
const MARKER_PREFIX = 'pw-loanimport-';

/** Distinct per run and stored on every imported loan's `reason`. */
const RUN_MARKER = marker(MARKER_PREFIX);

/**
 * The reference stem. Short on purpose: `referenceNo` is validated against
 * `^[A-Za-z0-9/_-]{3,40}$`, and it is also the term every list search in this
 * file uses to find its own rows.
 */
const REF = `LNI${Date.now().toString(36).toUpperCase()}`;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The fourteen columns, in order — `HEADERS` in `loan-import.service.ts`.
 *
 * This is the contract in the strongest sense available: the parser reads cells
 * by POSITION (`cell(i + 1)`) and skips row 1 unconditionally without ever
 * looking at what it says, so the order below is the only thing that makes a
 * sheet mean anything. The template test asserts the server ships exactly this.
 */
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
  'Deduction Frequency (MONTHLY/WEEKLY/QUARTERLY)',
];

/** Column indices, so a patched cell reads as the field it is. */
const C = {
  CODE: 0,
  REF: 1,
  TYPE: 2,
  PRINCIPAL: 3,
  METHOD: 4,
  RATE: 5,
  INSTALLMENTS: 6,
  EMI: 7,
  DISBURSED: 8,
  FIRST_PERIOD: 9,
  PAID: 10,
  REPAID: 11,
  STATUS: 12,
  NOTES: 13,
  FREQUENCY: 14,
} as const;

/** Yesterday: past enough to be legal, recent enough to need no maintenance. */
const DISBURSED_ON = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** Next month, as YYYY-MM. */
const NEXT_PERIOD = (() => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
})();

type Cell = string | number;

/**
 * A clean row: EMP002, 1,200 over 12 with no interest, so the derived
 * instalment is exactly 100.00 and every money assertion below is a whole
 * number rather than a rounding argument.
 */
const CLEAN: Cell[] = [
  'EMP002',
  '',
  'LOAN',
  1200,
  '',
  '',
  12,
  '',
  DISBURSED_ON,
  NEXT_PERIOD,
  '',
  '',
  'ACTIVE',
  RUN_MARKER,
];

/** `CLEAN` with a reference and zero or more cells replaced. */
function sheetRow(ref: string, patch: Record<number, Cell> = {}): Cell[] {
  const cells = [...CLEAN];
  cells[C.REF] = ref;
  for (const [index, value] of Object.entries(patch)) cells[Number(index)] = value;
  return cells;
}

/** Built in memory — no fixture file on disk to drift from the columns. */
function workbook(aoa: Cell[][], sheetName = 'Loans'): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── response shapes ─────────────────────────────────────────────────────────

interface PreviewRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  data: Record<string, unknown> & { employeeCode: string; referenceNo: string };
  derived?: {
    emi: number;
    totalInterest: number;
    installmentsConsumed: number;
    openingOutstanding: number;
    nextDuePeriod: string | null;
  };
}

interface PreviewBody {
  summary: { totalRows: number; validRows: number; invalidRows: number };
  rows: PreviewRow[];
}

interface ConfirmBody {
  importBatchId: string;
  summary: { total: number; imported: number; failed: number };
  results: Array<{ referenceNo: string; success: boolean; loanId?: string; error?: string }>;
}

interface LoanRow {
  id: string;
  status: string;
  type: string;
  amount: string;
  installments: number;
  installmentAmount: string | null;
  amountRepaid: string;
  outstandingPrincipal: string | null;
  outstandingInterest: string;
  interestPaid: string;
  referenceNo: string | null;
  reason: string | null;
  approvalSource: string;
  approvedAt: string | null;
  disbursementDate: string | null;
  employeeId: string;
  importBatchId: string | null;
}

/** The repayment-ledger rows the importer backfills for consumed instalments. */
interface DeductionRow {
  status: string;
  outcome: string | null;
  payrollItemId: string | null;
  amount: string;
  principalComponent: string;
}

interface StatementLoan {
  referenceNo: string | null;
  transactions: Array<{ type: string; amount: string; narration: string | null }>;
}

/**
 * `loanOf` deliberately returns an open record — the detail route carries the
 * whole request plus four included relations and every spec wants a different
 * corner of it. Naming the corner THIS file depends on is what makes an
 * assertion below readable, and what makes a dropped column fail here rather
 * than silently compare `undefined` to `undefined`.
 *
 * `scheduleOf` and `quoteOf` are already narrowed and already numeric, so they
 * are used exactly as they come.
 */
const asLoan = (value: unknown) => value as LoanRow;
const asDeductions = (value: unknown) => value as DeductionRow[];

// ── the three import endpoints, over HTTP ───────────────────────────────────

let adminApi: ApiClient;
let http: APIRequestContext;
let branchId = '';
let setupError = '';

/** Unwraps `{ success, data }` where it is used, and passes it through where it is not. */
function unwrap(text: string): any {
  if (!text) return null;
  try {
    const body = JSON.parse(text);
    return body?.data ?? body;
  } catch {
    return { raw: text };
  }
}

async function postPreview(
  token: string,
  file: { name: string; buffer: Buffer; mimeType?: string },
): Promise<{ status: number; body: any }> {
  const res = await http.post('/advance-loans/import/preview', {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: {
        name: file.name,
        mimeType: file.mimeType ?? XLSX_MIME,
        buffer: file.buffer,
      },
    },
  });
  return { status: res.status(), body: unwrap(await res.text()) };
}

async function postConfirm(
  token: string,
  rows: unknown[],
): Promise<{ status: number; body: any }> {
  const res = await http.post('/advance-loans/import/confirm', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { rows },
  });
  return { status: res.status(), body: unwrap(await res.text()) };
}

async function getTemplate(token: string): Promise<number> {
  const res = await http.get('/advance-loans/import/template', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status();
}

/** Previews a workbook as admin and fails loudly rather than returning junk. */
async function previewOk(buffer: Buffer, name = `${REF}.xlsx`): Promise<PreviewBody> {
  const { status, body } = await postPreview(adminApi.token, { name, buffer });
  expect(status, `preview failed: ${JSON.stringify(body)}`).toBe(201);
  return body as PreviewBody;
}

/** The rows the list search finds for a term — the same shape both tabs return. */
async function loansMatching(term: string): Promise<LoanRow[]> {
  const found = await adminApi.get<any>(
    `/advance-loans?page=1&limit=100&search=${encodeURIComponent(term)}`,
  );
  const rows = Array.isArray(found) ? found : (found?.data ?? []);
  return rows as LoanRow[];
}

/**
 * A second signed-in browser, for a persona the admin project cannot be.
 *
 * `browser.newContext()` does NOT inherit the config's `use` block, so baseURL
 * and timezone are passed explicitly — without the first, every relative `goto`
 * silently fails. Only the fatal half of the problem record is asserted: these
 * personas are looking at a screen they are not meant to be able to use, where a
 * logged 403 is the correct outcome.
 */
async function persona(
  browser: Browser,
  who: 'employee' | 'manager' | 'hr' | 'admin',
): Promise<{ context: BrowserContext; page: Page; done: () => Promise<void> }> {
  const context = await browser.newContext({
    baseURL: FRONTEND_URL,
    timezoneId: 'UTC',
    storageState: `${STORAGE_DIR}/${who}.json`,
  });
  const page = await context.newPage();
  const problems = watchForProblems(page);
  return {
    context,
    page,
    done: async () => {
      assertNoCrashes(problems, `the ${who} persona's page`);
      await context.close();
    },
  };
}

// ── setup / teardown ────────────────────────────────────────────────────────

test.beforeAll(async () => {
  if (!isProject('admin')) return;
  try {
    adminApi = await ApiClient.as('admin');
    branchId = await branchIdByCode(adminApi, 'HO');
    http = await request.newContext({ baseURL: API_URL });
  } catch (e) {
    setupError = (e as Error).message;
  }
});

test.afterAll(async () => {
  // One confirm can create many loans and a failed case leaves an unknown
  // number of them, so cleanup sweeps the marker rather than a kept list of ids.
  if (isProject('admin') && adminApi) {
    await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
  }
  await http?.dispose();
  await adminApi?.dispose();
});

// ───────────────────────────────────────────────────────────────────────────
// The template
// ───────────────────────────────────────────────────────────────────────────

test.describe('the template the operator downloads is the column contract', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  test('the downloaded workbook parses back to exactly the fifteen headers, in order', async ({
    page,
    problems,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await selectBranch(page, branchId);
    const modal = new LoanImportModalPage(page);
    await modal.open();
    expect(await modal.step()).toBe('UPLOAD');

    const bytes = await modal.downloadTemplate();
    expect(bytes.length, 'the template download produced no bytes').toBeGreaterThan(0);
    // `PK` — the zip local-file header every OOXML workbook starts with.
    expect(bytes.subarray(0, 2).toString('latin1'), 'the template is not a workbook').toBe('PK');

    // The bytes being a workbook is not the claim that matters. The parser reads
    // by POSITION and never reads the header row at all, so if the template ever
    // ships a column in a different place, every sheet built from it silently
    // means something else. Parsing it back is the only assertion that catches
    // that, and it is why this test exists beside the one in
    // finance-loan-lifecycle.spec.ts rather than instead of it.
    const parsed = XLSX.read(bytes, { type: 'buffer' });
    expect(parsed.SheetNames, 'the template lost its Loans worksheet').toContain('Loans');

    const grid = XLSX.utils.sheet_to_json<Cell[]>(parsed.Sheets['Loans'], { header: 1 });
    expect(grid[0], 'the template header row drifted from the parser').toEqual(HEADERS);
    // Fifteen since the deduction-frequency column was added: the engine had
    // always implemented WEEKLY and QUARTERLY and the sheet could not say so,
    // so every migrated loan became MONTHLY whatever it had been.
    expect(HEADERS.length).toBe(15);

    await modal.close();
    settle(problems, 'downloading the loan import template');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Preview validation — one row per fault, in one sheet
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every documented fault gets its OWN row in ONE workbook.
 *
 * One sheet rather than twenty, because the interesting property is not that a
 * bad row is refused — it is that a bad row is refused WITHOUT taking its
 * neighbours with it, and that only shows when they are neighbours. Each case
 * carries its own reference so an assertion names a fault rather than a line
 * number, which also survives the blank rows at the end being dropped before
 * they are ever numbered.
 */
const CASES = {
  unknownEmployee: { ref: `${REF}-01`, patch: { [C.CODE]: 'NO-SUCH-EMP' } },
  blankEmployee: { ref: `${REF}-02`, patch: { [C.CODE]: '' } },
  sameEmployeeA: { ref: `${REF}-03`, patch: {} },
  sameEmployeeB: { ref: `${REF}-04`, patch: {} },
  negativePrincipal: { ref: `${REF}-05`, patch: { [C.PRINCIPAL]: -500 } },
  zeroPrincipal: { ref: `${REF}-06`, patch: { [C.PRINCIPAL]: 0 } },
  threeDecimalPrincipal: { ref: `${REF}-07`, patch: { [C.PRINCIPAL]: 1000.125 } },
  missingInstallments: { ref: `${REF}-08`, patch: { [C.INSTALLMENTS]: '' } },
  zeroInstallments: { ref: `${REF}-09`, patch: { [C.INSTALLMENTS]: 0 } },
  aboveMaxInstallments: { ref: `${REF}-10`, patch: { [C.INSTALLMENTS]: 240 } },
  mismatchedEmi: { ref: `${REF}-11`, patch: { [C.EMI]: 999 } },
  rateWithoutMethod: { ref: `${REF}-12`, patch: { [C.RATE]: 5 } },
  unknownMethod: { ref: `${REF}-13`, patch: { [C.METHOD]: 'COMPOUND' } },
  malformedDate: { ref: `${REF}-14`, patch: { [C.DISBURSED]: '15-01-2026' } },
  impossibleDate: { ref: `${REF}-15`, patch: { [C.DISBURSED]: '2025-02-31' } },
  periodBeforeDisbursement: { ref: `${REF}-16`, patch: { [C.FIRST_PERIOD]: '2025-01' } },
  paidOverTotal: { ref: `${REF}-17`, patch: { [C.INSTALLMENTS]: 6, [C.PAID]: 9 } },
  repaidOverPrincipal: { ref: `${REF}-18`, patch: { [C.REPAID]: 5000 } },
  unknownStatus: { ref: `${REF}-19`, patch: { [C.STATUS]: 'FROZEN' } },
} as const;

/** 19 rows that are counted, plus two that are not. */
const VALIDATION_SHEET = () =>
  workbook([
    HEADERS,
    ...Object.values(CASES).map((c) => sheetRow(c.ref, c.patch as Record<number, Cell>)),
    // Neither of these is a row: both are dropped before they are numbered,
    // because `HEADERS.every((_, i) => cell(i + 1) === '')` short-circuits the
    // loop and `cell()` trims. An operator who leaves a gap at the bottom of a
    // sheet must not be told they have two broken rows.
    HEADERS.map(() => ''),
    HEADERS.map(() => '   '),
  ]);

/** Rows the validator should pass. Every other case must be refused.
 *  Typed as plain strings: each `ref` is a template-literal type, and their
 *  union would not accept the `string` a preview row carries back.
 *
 *  Three cases moved OUT of this list when the importer's validation was
 *  tightened, and each was a real fault the sheet used to smuggle through:
 *   - `threeDecimalPrincipal` — was silently rounded by the minor-unit
 *     conversion, so the imported loan disagreed with its spreadsheet.
 *   - `impossibleDate` — `2025-02-31` does not produce an Invalid Date in
 *     Node; it ROLLS OVER to 2025-03-03, so the loan was created live and
 *     dated three days after the sheet said.
 *   - `periodBeforeDisbursement` — the two date fields were shape-checked and
 *     never checked against each other, so an instalment could fall due before
 *     the money was paid out.
 *  `aboveMaxInstallments` stays valid on purpose: an importer migrates
 *  history, and history is not subject to today's cap. It carries a warning. */
const VALID_CASES: readonly string[] = [
  CASES.sameEmployeeA.ref,
  CASES.sameEmployeeB.ref,
  CASES.aboveMaxInstallments.ref,
];

test.describe('preview reports one reason per row, and writes nothing at all', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  test('each documented fault is reported against its own row, in the server’s own words', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const preview = await previewOk(VALIDATION_SHEET(), `${REF}-validation.xlsx`);
    const byRef = new Map(preview.rows.map((r) => [r.data.referenceNo, r]));
    const rowFor = (ref: string): PreviewRow => {
      const found = byRef.get(ref);
      if (!found) throw new Error(`preview did not report a row for ${ref}`);
      return found;
    };
    const errors = (ref: string) => rowFor(ref).errors;

    /**
     * A refused row: it IS refused, and it says the thing this case is about.
     *
     * `toContain` rather than `toEqual` because one bad cell can legitimately
     * trip more than one validator — a negative principal also makes the (zero)
     * Amount Already Repaid exceed it, so `${REF}-05` comes back with both
     * sentences. The cascade is the server being thorough, not the case
     * failing; the row still has to be invalid and still has to name the fault
     * under test, which is what an operator acts on.
     */
    const expectRefusedFor = (ref: string, message: string) => {
      expect(rowFor(ref).valid, `${ref} was expected to be refused`).toBe(false);
      expect(errors(ref), `${ref} did not name the fault it is here to prove`).toContain(message);
    };

    // The two trailing rows are not counted at all — 21 lines in, 19 rows out.
    expect(preview.summary.totalRows, 'a blank or whitespace-only line was counted as a row').toBe(
      19,
    );
    expect(preview.summary.validRows).toBe(VALID_CASES.length);
    expect(preview.summary.invalidRows).toBe(19 - VALID_CASES.length);
    expect(preview.rows.length).toBe(19);

    // ── who the loan belongs to ────────────────────────────────────────────
    expectRefusedFor(CASES.unknownEmployee.ref, 'No employee with code NO-SUCH-EMP');
    expectRefusedFor(CASES.blankEmployee.ref, 'Employee Code is required');

    // Two loans for the SAME person in one sheet is allowed: the file de-dupes
    // REFERENCES (against the database and against itself), never employees.
    // The live-loan allowance is not consulted here at all — an importer is
    // migrating history, and history is not subject to today's cap.
    expect(rowFor(CASES.sameEmployeeA.ref).valid).toBe(true);
    expect(rowFor(CASES.sameEmployeeB.ref).valid).toBe(true);
    expect(rowFor(CASES.sameEmployeeA.ref).data.employeeCode).toBe(
      rowFor(CASES.sameEmployeeB.ref).data.employeeCode,
    );

    // ── the money ──────────────────────────────────────────────────────────
    // A negative principal trips the repaid-vs-principal check too (0 > -500),
    // so this row carries two sentences by design — see `expectRefusedFor`.
    expectRefusedFor(CASES.negativePrincipal.ref, 'Principal Amount must be greater than 0');
    expectRefusedFor(CASES.zeroPrincipal.ref, 'Principal Amount must be greater than 0');

    // 1000.125 used to be accepted and silently rounded to 1000.13 by the
    // minor-unit conversion, so the imported loan disagreed with the sheet it
    // came from and nothing said so. Money is refused above 2dp now.
    expectRefusedFor(
      CASES.threeDecimalPrincipal.ref,
      'Principal Amount cannot have more than 2 decimal places',
    );

    // ── the repayment period ───────────────────────────────────────────────
    expectRefusedFor(
      CASES.missingInstallments.ref,
      'Total Installments must be a whole number of at least 1',
    );
    expectRefusedFor(
      CASES.zeroInstallments.ref,
      'Total Installments must be a whole number of at least 1',
    );

    // Above the configured maximum is a WARNING, not an error: the cap is
    // today's lending policy and this is somebody else's already-signed loan.
    // The row still imports, which is the deliberate part.
    const overLong = rowFor(CASES.aboveMaxInstallments.ref);
    expect(overLong.valid).toBe(true);
    expect(overLong.errors).toEqual([]);
    expect(overLong.warnings.join(' | ')).toMatch(
      /Installments \(240\) exceed the configured maximum of \d+/,
    );

    // A blank EMI is the normal case — the engine derives it. 1,200 over 12 at
    // no interest is exactly 100.00, and a supplied figure more than 1.00 away
    // from that is refused rather than trusted.
    expect(rowFor(CASES.sameEmployeeA.ref).derived?.emi).toBe(100);
    expectRefusedFor(
      CASES.mismatchedEmi.ref,
      'EMI Amount 999 does not match the derived instalment of 100 for these terms',
    );

    // ── interest ───────────────────────────────────────────────────────────
    expectRefusedFor(
      CASES.rateWithoutMethod.ref,
      'An interest rate was given but the method is NONE',
    );
    expectRefusedFor(
      CASES.unknownMethod.ref,
      'Interest Method must be NONE, FLAT or REDUCING_BALANCE',
    );

    // ── dates ──────────────────────────────────────────────────────────────
    expectRefusedFor(CASES.malformedDate.ref, 'Disbursed On must be YYYY-MM-DD');

    // `2025-02-31` satisfies the YYYY-MM-DD regex, and — the part that made
    // this dangerous — it does NOT produce an Invalid Date in Node. It rolls
    // over to 2025-03-03, so the row previewed clean and created a live loan
    // dated three days after the sheet said. Silent corruption, not a late
    // failure. A shape test is not a date test; there is a real one now.
    expectRefusedFor(CASES.impossibleDate.ref, 'Disbursed On is not a real calendar date');

    // A First Deduction Month BEFORE the disbursement date used to be accepted
    // — the two fields were validated for shape and never against each other,
    // so a schedule's first instalment could fall due before the money was
    // paid out. The same month is still allowed; earlier is not.
    expectRefusedFor(
      CASES.periodBeforeDisbursement.ref,
      'First Deduction Month is before Disbursed On',
    );

    // ── opening history ────────────────────────────────────────────────────
    expectRefusedFor(
      CASES.paidOverTotal.ref,
      'Installments Already Paid exceeds Total Installments',
    );
    expectRefusedFor(CASES.repaidOverPrincipal.ref, 'Amount Already Repaid exceeds the principal');

    // ── the status the loan lands in ───────────────────────────────────────
    expectRefusedFor(CASES.unknownStatus.ref, 'Status must be ACTIVE, CLOSED or ON_HOLD');

    // Every case not on the valid list is refused, and every refusal explains
    // itself — a count with no sentence is not something an operator can act on.
    for (const row of preview.rows) {
      if (VALID_CASES.includes(row.data.referenceNo)) continue;
      expect(row.valid, `${row.data.referenceNo} was expected to be refused`).toBe(false);
      expect(row.errors.length, `${row.data.referenceNo} was refused without a reason`).toBeGreaterThan(
        0,
      );
    }
  });

  test('the modal counts the same sheet the same way, and the preview creates nothing', async ({
    page,
    problems,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await selectBranch(page, branchId);
    const modal = new LoanImportModalPage(page);
    await modal.open();
    await modal.choose({ name: `${REF}-validation.xlsx`, buffer: VALIDATION_SHEET() });

    // Read from `data-count`, never from the "19 rows" sentence beside it —
    // that string exists in two languages.
    const counts = await modal.preview();
    expect(counts.total).toBe(19);
    expect(counts.valid).toBe(VALID_CASES.length);
    expect(counts.invalid).toBe(19 - VALID_CASES.length);

    // Six good rows in a mostly-broken sheet still offers the import: refusing
    // the whole file because part of it is wrong is what makes operators edit
    // spreadsheets until they stop being checkable.
    expect(await modal.confirmEnabled()).toBe(true);

    // The safety property of a two-phase import, and the one an "optimisation"
    // into a single call would silently lose. Asserted for the WHOLE stem, so a
    // row this file never even named would still be caught.
    await expect
      .poll(async () => (await loansMatching(REF)).length, {
        timeout: 15_000,
        message: 'preview created loans',
      })
      .toBe(0);

    // Leave without confirming — those 19 rows are the validation fixture and
    // must stay unimported for the file to be re-previewable.
    await modal.close();
    settle(problems, 'previewing a spreadsheet of broken loan rows');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Confirm
// ───────────────────────────────────────────────────────────────────────────

test.describe('confirm creates the valid rows, live, with no approval anywhere', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  const good1 = `${REF}-C1`;
  const good2 = `${REF}-C2`;
  const bad = `${REF}-C3`;

  test('two good rows and one bad one import as two live, referenced, scheduled loans', async ({
    page,
    problems,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const buffer = workbook([
      HEADERS,
      sheetRow(good1),
      sheetRow(bad, { [C.CODE]: 'NO-SUCH-EMP' }),
      sheetRow(good2, { [C.INSTALLMENTS]: 6 }),
    ]);

    await selectBranch(page, branchId);
    const modal = new LoanImportModalPage(page);
    await modal.open();
    await modal.choose({ name: `${REF}-confirm.xlsx`, buffer });

    const counts = await modal.preview();
    expect(counts.total).toBe(3);
    expect(counts.valid).toBe(2);
    expect(counts.invalid).toBe(1);

    await modal.confirm();
    const results = await modal.results();
    // `failed` is 0, not 1: the modal sends `rows.filter(r => r.valid)`, so the
    // refused row is never offered to the server at all. The invalid COUNT is
    // the preview's job; the results panel only reports what was attempted.
    expect(results.imported).toBe(2);
    expect(results.failed).toBe(0);
    await modal.close();

    // The screen reporting "2 imported" is not the same claim as two loans
    // existing with the terms the sheet asked for.
    await expect
      .poll(async () => (await loansMatching(`${REF}-C`)).length, {
        timeout: 20_000,
        message: 'confirm reported an import that produced no loans',
      })
      .toBe(2);

    const created = await loansMatching(`${REF}-C`);
    expect(created.map((l) => l.referenceNo).sort()).toEqual([good1, good2]);
    expect(created.some((l) => l.referenceNo === bad), 'the refused row was imported anyway').toBe(
      false,
    );

    for (const summary of created) {
      const loan = asLoan(await loanOf(adminApi, summary.id));

      // The whole point of the importer: these loans were approved somewhere
      // else, so they enter the ledger LIVE rather than PENDING. Nothing here
      // ever passed through the approval engine.
      expect(loan.status, 'an imported loan waited for an approval it will never get').toBe(
        'ACTIVE',
      );
      expect(loan.approvalSource).toBe('IMPORT');
      expect(loan.approvedAt, 'an imported loan has no approval instant').toBeTruthy();
      expect(loan.referenceNo).toBeTruthy();
      expect(loan.importBatchId, 'the batch that created this loan is not recorded').toBeTruthy();
      expect(loan.reason ?? '').toContain(MARKER_PREFIX);
      expect(Number(loan.amount)).toBe(1200);

      // A schedule is what payroll recovers against; an imported loan without
      // one is a balance nobody will ever collect.
      const schedule = await scheduleOf(adminApi, loan.id);
      expect(schedule.length).toBe(loan.installments);
      expect(schedule.every((s) => s.status === 'SCHEDULED')).toBe(true);
      expect(schedule[0].openingBalance).toBe(1200);
      expect(schedule[schedule.length - 1].closingBalance).toBe(0);
    }

    settle(problems, 'importing a spreadsheet of loans');
  });

  test('an opening history backfills paid instalments, a disbursement and an amortised remainder', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const ref = `${REF}-H1`;
    // 1,200 over 12 at no interest: an exact 100.00 instalment, two of them
    // already consumed elsewhere, and 200.00 of principal already repaid — so
    // every figure below is a whole number and a rounding argument cannot hide
    // a real disagreement.
    const preview = await previewOk(
      workbook([HEADERS, sheetRow(ref, { [C.PAID]: 2, [C.REPAID]: 200 })]),
      `${REF}-history.xlsx`,
    );
    expect(preview.summary.validRows).toBe(1);
    const row = preview.rows[0];
    expect(row.errors).toEqual([]);
    // A repaid figure that agrees with the consumed instalments produces no
    // reconciliation warning; a disagreement would.
    expect(row.warnings).toEqual([]);
    expect(row.derived?.installmentsConsumed).toBe(2);
    expect(row.derived?.openingOutstanding).toBe(1000);
    expect(row.derived?.nextDuePeriod, 'the third instalment is the next one due').toBeTruthy();

    const { status, body } = await postConfirm(adminApi.token, [row.data]);
    expect(status, `confirm failed: ${JSON.stringify(body)}`).toBe(201);
    const confirmed = body as ConfirmBody;
    expect(confirmed.summary).toMatchObject({ total: 1, imported: 1, failed: 0 });

    const loanId = confirmed.results[0].loanId!;
    expect(loanId).toBeTruthy();

    const loan = asLoan(await loanOf(adminApi, loanId));
    expect(loan.status).toBe('ACTIVE');
    expect(loan.approvalSource).toBe('IMPORT');
    expect(Number(loan.amountRepaid), 'the opening repaid figure did not survive').toBe(200);
    expect(Number(loan.outstandingPrincipal)).toBe(1000);
    expect(Number(loan.outstandingInterest)).toBe(0);
    expect(Number(loan.interestPaid)).toBe(0);

    // THE detail that makes an imported mid-life loan behave. Payroll derives
    // its pick-up from history, so without PAID rows this loan would look brand
    // new and be recovered from instalment 1 all over again.
    const schedule = await scheduleOf(adminApi, loanId);
    expect(schedule.length).toBe(12);
    expect(schedule.map((s) => s.status)).toEqual([
      'PAID',
      'PAID',
      ...Array<string>(10).fill('SCHEDULED'),
    ]);
    expect(schedule[0].paidAmount).toBe(100);
    expect(schedule[1].paidAmount).toBe(100);
    expect(schedule[2].paidAmount, 'a future instalment was marked as paid').toBe(0);

    // The remainder amortises the REMAINING balance: the third instalment opens
    // on 1,000 — what is actually still owed — and the plan still lands on zero.
    expect(schedule[2].openingBalance).toBe(1000);
    expect(schedule[11].closingBalance).toBe(0);
    const scheduledPrincipal = schedule
      .slice(2)
      .reduce((sum, s) => sum + s.principalComponent, 0);
    expect(Math.round(scheduledPrincipal * 100) / 100).toBe(1000);

    // And the same two instalments exist in the REPAYMENT LEDGER, which is the
    // half that actually changes behaviour: `LoanRecoveryService` derives its
    // pick-up from these rows, not from the schedule, so an imported mid-life
    // loan without them is recovered from instalment 1 all over again.
    // `payrollItemId` is null because no payroll run ever produced them.
    const ledger = asDeductions(await deductionsFor(adminApi, loanId));
    expect(ledger.length, 'the consumed instalments were not written to the ledger').toBe(2);
    expect(ledger.every((d) => d.status === 'PAID')).toBe(true);
    expect(ledger.every((d) => d.payrollItemId === null)).toBe(true);
    expect(ledger.reduce((sum, d) => sum + Number(d.principalComponent), 0)).toBe(200);

    // The DISBURSEMENT is what makes the money real: a loan whose ledger has no
    // outflow is a receivable that was never paid out.
    const statement = await adminApi.get<StatementLoan[]>(
      `/advance-loans/reports/employee/${loan.employeeId}/statement`,
    );
    const entry = (Array.isArray(statement) ? statement : []).find((l) => l.referenceNo === ref);
    expect(entry, 'the imported loan is missing from the employee statement').toBeTruthy();
    const disbursements = entry!.transactions.filter((t) => t.type === 'DISBURSEMENT');
    expect(disbursements.length).toBe(1);
    expect(Number(disbursements[0].amount)).toBe(1200);
    // No reconciliation adjustment: the repaid figure agreed with the consumed
    // instalments exactly, so there was nothing to book.
    expect(entry!.transactions.filter((t) => t.type === 'ADJUSTMENT').length).toBe(0);

    const quote = await quoteOf(adminApi, loanId);
    expect(quote.outstandingPrincipal).toBe(1000);
    expect(quote.outstandingInterest).toBe(0);
    expect(quote.payoffAmount, 'the payoff disagrees with the opening balance').toBe(1000);
  });

  test('a duplicate reference fails its own row and the rest of the batch still lands', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const dup = `${REF}-D1`;
    const survivor = `${REF}-D2`;

    // Preview refuses a repeated reference outright, so the only way to reach
    // the unique index is to post it — which is exactly what a client that
    // double-submits, or retries a timed-out confirm, does.
    const inFile = await previewOk(
      workbook([HEADERS, sheetRow(dup), sheetRow(dup)]),
      `${REF}-dup.xlsx`,
    );
    expect(inFile.rows[1].errors).toEqual([
      `Loan Reference No ${dup} is duplicated in this file`,
    ]);

    const clean = await previewOk(
      workbook([HEADERS, sheetRow(dup), sheetRow(survivor)]),
      `${REF}-dup2.xlsx`,
    );
    const [first, second] = clean.rows;
    expect(first.valid && second.valid).toBe(true);

    // The same reference twice, plus a good row AFTER it: if the batch aborted
    // on the failure, the survivor would never be created.
    const { status, body } = await postConfirm(adminApi.token, [
      first.data,
      { ...first.data },
      second.data,
    ]);
    expect(status, `confirm failed: ${JSON.stringify(body)}`).toBe(201);
    const confirmed = body as ConfirmBody;

    expect(confirmed.summary.total).toBe(3);
    expect(confirmed.summary.imported, 'the duplicate rolled back its neighbours').toBe(2);
    expect(confirmed.summary.failed).toBe(1);
    expect(confirmed.results[0].success).toBe(true);
    expect(confirmed.results[1].success).toBe(false);
    expect(confirmed.results[2].success, 'the row after the failure was abandoned').toBe(true);

    // Per-row transactions mean the failure is reported in place rather than as
    // a 500 over the whole request.
    // BUG?: `results[].error` is the raw thrown message, so Prisma's own text —
    // which embeds the checkout path and an excerpt of the failing source — is
    // handed to the client here, bypassing AllExceptionsFilter's deliberate
    // "Internal server error" scrubbing.
    expect(confirmed.results[1].error ?? '').toMatch(
      /Loan Reference No .* is duplicated in this file/i,
    );

    // The database holds one of it, not two.
    await expect
      .poll(async () => (await loansMatching(dup)).length, {
        timeout: 15_000,
        message: 'the unique reference index did not hold',
      })
      .toBe(1);
    expect((await loansMatching(survivor)).length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// What the endpoint accepts as a FILE
// ───────────────────────────────────────────────────────────────────────────

test.describe('the upload refuses what is not a workbook, before it reads anything', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  test('a .csv is refused by extension and a file above 10 MB is refused by size', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // An 11 MB upload over loopback is not slow, but it is not instant either.
    test.setTimeout(90_000);

    // The filter reads the NAME, not the bytes: this is a perfectly good CSV of
    // the right columns and it is still refused, because a parser that guessed
    // would guess wrong on the day it mattered.
    const csv = Buffer.from(
      `${HEADERS.join(',')}\nEMP002,${REF}-CSV,LOAN,1200,,,12,,${DISBURSED_ON},${NEXT_PERIOD},,,ACTIVE,${RUN_MARKER}\n`,
      'utf8',
    );
    const rejected = await postPreview(adminApi.token, {
      name: `${REF}.csv`,
      buffer: csv,
      mimeType: 'text/csv',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body?.message).toBe('Only .xlsx or .xls files are accepted');

    // The cap is `limits.fileSize = 10 * 1024 * 1024` on the interceptor, which
    // multer aborts mid-stream; Nest's `transformException` turns that into a
    // 413 rather than letting a MulterError reach the client as a 500.
    const oversized = await postPreview(adminApi.token, {
      name: `${REF}-big.xlsx`,
      buffer: Buffer.alloc(11 * 1024 * 1024, 0x41),
    });
    expect(oversized.status, 'a file above the 10 MB cap was accepted').toBe(413);

    // Nothing was created by either refusal.
    expect((await loansMatching(`${REF}-CSV`)).length).toBe(0);
  });

  test('an empty workbook and a header-only sheet are empty; a wrong header row is refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // A workbook with a worksheet and no cells is not an error — it is a sheet
    // with nothing in it, and the operator is told exactly that.
    const empty = await previewOk(workbook([]), `${REF}-empty.xlsx`);
    expect(empty.summary.totalRows).toBe(0);
    expect(empty.summary.validRows).toBe(0);
    expect(empty.rows).toEqual([]);

    // Header row only: row 1 is skipped unconditionally, so there is nothing left.
    const headerOnly = await previewOk(workbook([HEADERS]), `${REF}-header.xlsx`);
    expect(headerOnly.summary.totalRows).toBe(0);

    // The header row is validated against the template now, so a sheet whose
    // columns do not match is refused as a FILE — 400 for the whole upload,
    // naming the first column that disagrees. It used to be skipped
    // unconditionally and every cell read by POSITION, so renaming the columns
    // or writing them in reverse changed nothing: a genuinely reordered sheet
    // (headers and data together) was parsed as though it had not been, and the
    // operator's first sign of trouble was a loan with the wrong terms.
    const renamed = await postPreview(adminApi.token, {
      name: `${REF}-renamed.xlsx`,
      buffer: workbook([HEADERS.map((h) => `Not ${h}`), sheetRow(`${REF}-RN`)]),
    });
    expect(renamed.status, 'a renamed header row was accepted').toBe(400);
    expect(String(renamed.body?.message)).toContain(
      'The header row does not match the import template',
    );
    // It names the column, not just the fact — an operator with fourteen
    // columns needs to know which one to look at.
    expect(String(renamed.body?.message)).toContain('column 1 should be "Employee Code *"');

    const reordered = await postPreview(adminApi.token, {
      name: `${REF}-reordered.xlsx`,
      buffer: workbook([[...HEADERS].reverse(), sheetRow(`${REF}-RO`)]),
    });
    expect(reordered.status, 'a reversed header row was accepted').toBe(400);
    expect(String(reordered.body?.message)).toContain(
      'The header row does not match the import template',
    );

    // Still a preview: none of the four created anything.
    expect((await loansMatching(`${REF}-R`)).length).toBe(0);
  });

  test('a file that is not a workbook at all is answered as the client’s mistake', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const { status, body } = await postPreview(adminApi.token, {
      name: `${REF}-fake.xlsx`,
      buffer: Buffer.from('this is not a workbook, it is a sentence', 'utf8'),
    });

    // The extension filter passes and ExcelJS throws a plain Error on the
    // missing zip directory. That used to reach `AllExceptionsFilter`, which
    // maps every non-HttpException to a 500 "Internal server error" — so a
    // malformed upload, which is the client's mistake, was indistinguishable
    // from the backend falling over and tripped every 5xx alarm the suite has.
    // It is a 400 that says which file was bad.
    expect(status).toBe(400);
    expect(String(body?.message)).toContain(
      'That file could not be read as an Excel workbook',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The size cap on confirm
// ───────────────────────────────────────────────────────────────────────────

test.describe('confirm caps the batch at two thousand rows', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  /**
   * A row that is well-formed enough to pass the DTO and guaranteed to fail in
   * the loop, so the cap can be tested at full size without creating 2,000
   * loans. The employee lookup is the first thing `confirm` does per row, and it
   * throws before a transaction is ever opened.
   */
  const bulkRow = (n: number) => ({
    employeeCode: 'NOSUCHIMP',
    referenceNo: `${REF}-B${n}`,
    type: 'LOAN',
    principal: 1200,
    interestMethod: 'NONE',
    interestRate: 0,
    installments: 12,
    disbursedOn: DISBURSED_ON,
    firstDeductionPeriod: NEXT_PERIOD,
    installmentsPaid: 0,
    amountRepaid: 0,
    status: 'ACTIVE',
    notes: RUN_MARKER,
  });

  test('two thousand rows are accepted and every one of them is answered; two thousand and one are refused', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // Two full-size batches over HTTP, each answering per row. Generous on
    // purpose: an import of this many rows is the slowest thing this file does.
    test.setTimeout(240_000);

    const atCap = Array.from({ length: 2000 }, (_, i) => bulkRow(i + 1));
    const accepted = await postConfirm(adminApi.token, atCap);
    expect(accepted.status, `the cap refused a batch of exactly 2000: ${JSON.stringify(accepted.body)}`).toBe(
      201,
    );
    const body = accepted.body as ConfirmBody;
    expect(body.summary.total).toBe(2000);
    // Every row is answered individually — the loop is a loop, not a single
    // statement that gives up on the first refusal.
    expect(body.results.length).toBe(2000);
    expect(body.summary.imported).toBe(0);
    expect(body.summary.failed).toBe(2000);
    expect(body.results[1999].error ?? '').toContain('No employee with code NOSUCHIMP');

    // NOTE: these rows are deliberately small. `main.ts` caps the JSON body at
    // 1 MB, and a REAL 2,000-row batch (longer references, a filled Notes
    // column) exceeds that long before `@ArrayMaxSize(2000)` is consulted — so
    // the advertised ceiling is not reachable with realistic rows.
    // BUG?: the DTO promises 2,000 rows that the body parser will not carry.

    const overCap = await postConfirm(adminApi.token, [...atCap, bulkRow(2001)]);
    expect(overCap.status, '@ArrayMaxSize(2000) did not hold').toBe(400);

    // Nothing in either batch reached the database.
    expect((await loansMatching(`${REF}-B`)).length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The probe: confirm re-checks everything preview checked
// ───────────────────────────────────────────────────────────────────────────

test.describe('confirm re-validates every row it is handed', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'importing loans is an ADMIN/HR flow');
  });

  test('a row mutated after a clean preview is refused, on every term the preview checked', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    // The mutated row asks for 240 instalments, which is 240 schedule rows
    // written inside one transaction.
    test.setTimeout(120_000);

    // A clean, ordinary preview — the thing a well-behaved client would send back.
    const preview = await previewOk(
      workbook([HEADERS, sheetRow(`${REF}-P0`)]),
      `${REF}-probe.xlsx`,
    );
    expect(preview.rows[0].valid).toBe(true);
    const approved = preview.rows[0].data;

    const absurdRef = `${REF}-P1`;
    const negativeRef = `${REF}-P2`;
    const foreignRef = `${REF}-P3`;

    /**
     * The attack this closes: `ConfirmLoanImportDto.rows` is `any[]` behind
     * `@IsArray()` and `@ArrayMaxSize(2000)`, so the PIPE cannot judge a row.
     * `confirm` used to re-derive the schedule from whatever it was handed
     * without re-running any of the preview's rules, and nothing bound a confirm
     * to the preview that produced it. Preview something innocuous, send
     * something else, and an arbitrary live loan appeared on arbitrary terms
     * against an arbitrary employee, with no approval anywhere.
     *
     * Now `validateImportRow()` is one function called by BOTH preview and
     * confirm — there is no second copy to drift — and preview additionally
     * signs each row it approves. So: preview something innocuous, send
     * something else, and watch it be refused.
     */
    const { status, body } = await postConfirm(adminApi.token, [
      // 625x the principal that was previewed. The signature covers the row's
      // money and terms, so altering either invalidates it.
      { ...approved, referenceNo: absurdRef, principal: 750000, installments: 240 },
      // The one shape that IS stopped, and not by validation — the amortization
      // engine asserts its own inputs and throws.
      { ...approved, referenceNo: negativeRef, principal: -500 },
      // An employee no preview ever saw. The code is resolved fresh at confirm
      // time, so the row does not have to have come from a file at all.
      { ...approved, referenceNo: foreignRef, employeeCode: 'MGR001' },
    ]);

    expect(status, `confirm failed outright: ${JSON.stringify(body)}`).toBe(201);
    const confirmed = body as ConfirmBody;
    expect(confirmed.summary.total).toBe(3);

    const byRef = new Map(confirmed.results.map((r) => [r.referenceNo, r]));

    // The row whose money was rewritten is refused, and NOTHING is created for
    // it. This is the case that mattered: 625x the previewed principal, over 20x
    // the configured repayment period, previously created verbatim and live.
    const absurd = byRef.get(absurdRef);
    expect(
      absurd?.success,
      'a row mutated after preview was created anyway — confirm is not re-validating',
    ).toBe(false);
    expect(absurd?.loanId, 'a refused row still produced a loan').toBeFalsy();
    expect(absurd?.error ?? '', 'the refusal does not say what was wrong').not.toBe('');

    // A negative principal is refused too. It always was — but by the
    // amortization engine asserting its own inputs, in a developer's words,
    // rather than by a validator in an operator's.
    expect(byRef.get(negativeRef)?.success).toBe(false);
    expect(byRef.get(negativeRef)?.loanId).toBeFalsy();

    // And a row naming an employee no preview ever looked at. The confirm
    // payload still carries the employee code, so without re-validation an
    // ADMIN/HR client could book a loan against anyone at all.
    expect(
      byRef.get(foreignRef)?.success,
      'a never-previewed employee was accepted',
    ).toBe(false);
    expect(byRef.get(foreignRef)?.loanId).toBeFalsy();

    // Nothing from this probe reached the book.
    expect(confirmed.summary.imported, 'a mutated batch created loans').toBe(0);
    expect(confirmed.summary.failed).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Who may import at all
// ───────────────────────────────────────────────────────────────────────────

test.describe('importing is closed to everyone but ADMIN and HR', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the persona windows are opened from the admin project');
  });

  test('manager and employee are refused all three endpoints and are never offered the button', async ({
    browser,
  }) => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const sheet = workbook([HEADERS, sheetRow(`${REF}-RB`)]);

    for (const who of ['manager', 'employee'] as const) {
      const api = await ApiClient.as(who);
      try {
        // The RolesGuard runs before the file interceptor, so the refusal lands
        // without the workbook ever being written to disk.
        expect(await getTemplate(api.token), `${who} downloaded the template`).toBe(403);
        expect(
          (await postPreview(api.token, { name: `${REF}-${who}.xlsx`, buffer: sheet })).status,
          `${who} previewed an import`,
        ).toBe(403);
        expect(
          (await postConfirm(api.token, [{ employeeCode: 'EMP002', referenceNo: `${REF}-X` }]))
            .status,
          `${who} confirmed an import`,
        ).toBe(403);
      } finally {
        await api.dispose();
      }

      // And the screen agrees with the server: `isHROrAdmin` gates the button,
      // so there is nothing to click rather than a button that 403s.
      const view = await persona(browser, who);
      try {
        await view.page.goto('/dashboard/advance-loans', { waitUntil: 'domcontentloaded' });
        await view.page.waitForLoadState('networkidle').catch(() => {});
        await expect(view.page.getByTestId('loan-import')).toHaveCount(0);
      } finally {
        await view.done();
      }
    }

    // The refused calls created nothing.
    expect((await loansMatching(`${REF}-RB`)).length).toBe(0);
    expect((await loansMatching(`${REF}-X`)).length).toBe(0);
  });
});
