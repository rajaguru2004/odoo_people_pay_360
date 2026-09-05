import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { roundMoney } from '../common/utils/money.util';
import {
  generateSchedule,
  LoanAmortizationError,
  type AmortizationResult,
  type Frequency,
  type InterestMethod,
} from './loan-amortization.util';
import { LoanRecoveryService } from './loan-recovery.service';
import { LoanScheduleService } from './loan-schedule.service';

export interface ImportLoanRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  data: {
    employeeCode: string;
    referenceNo: string;
    type: string;
    principal: number;
    interestMethod: string;
    interestRate: number;
    installments: number;
    emi?: number | null;
    disbursedOn: string;
    firstDeductionPeriod: string;
    installmentsPaid: number;
    amountRepaid: number;
    status: string;
    notes?: string;
    /** Blank in the sheet means MONTHLY — what the importer used to assume. */
    deductionFrequency: string;
    /**
     * Stamped by `preview` on rows it called valid; see `signRow`. Never part
     * of what is signed, and never persisted.
     */
    signature?: string;
  };
  derived?: {
    emi: number;
    totalInterest: number;
    installmentsConsumed: number;
    openingOutstanding: number;
    nextDuePeriod: string | null;
  };
}

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
  // Appended rather than inserted: the header row is validated position by
  // position, so a new column anywhere else would reject every sheet already
  // in circulation. Blank means MONTHLY, which is what the importer used to
  // hard-code for every row regardless of the loan being migrated.
  'Deduction Frequency (MONTHLY/WEEKLY/QUARTERLY)',
];

/**
 * The fields that make a row what it is, in a fixed order.
 *
 * Fixed, because the signature is computed over the values in THIS order —
 * `JSON.stringify` of an object would otherwise depend on key insertion order,
 * which survives neither a JSON round-trip through a browser nor a client that
 * rebuilds the object. `signature` itself is excluded: it signs the rest.
 */
const SIGNED_FIELDS = [
  'employeeCode',
  'referenceNo',
  'type',
  'principal',
  'interestMethod',
  'interestRate',
  'installments',
  'emi',
  'disbursedOn',
  'firstDeductionPeriod',
  'installmentsPaid',
  'amountRepaid',
  'status',
  'notes',
  'deductionFrequency',
] as const;

/** A row as it arrives — from a spreadsheet cell or from a JSON body. */
export type RawImportRow = Partial<
  Record<(typeof SIGNED_FIELDS)[number] | 'signature', unknown>
>;

/**
 * Everything `validateImportRow` needs that it cannot work out from the row.
 *
 * Passed in rather than read inside, so the validator stays a pure function:
 * `preview` prefetches these once for the whole sheet and `confirm` prefetches
 * them once for the whole batch, and neither turns into an N+1 per row.
 */
export interface ImportRowContext {
  /** The employee `employeeCode` resolved to, or null/undefined if it did not. */
  employee?: { startDate?: Date | string | null } | null;
  /** `advance_loan_max_installments`, already coerced to a number. */
  maxInstallments: number;
  /** `loan_interest_enabled === 'true'`. */
  interestEnabled: boolean;
  /** Reference numbers that already exist in the database. */
  refsInDb: ReadonlySet<string>;
  /**
   * References already claimed by an EARLIER row of the same file/batch.
   * Mutated by the validator, exactly as the original inline loop did.
   */
  refsSeen: Set<string>;
  /** Injected so a test can pin "today". */
  now?: Date;
}

export interface ImportRowValidation {
  errors: string[];
  warnings: string[];
  /** The normalized row. Identical for a spreadsheet cell and a JSON value. */
  data: ImportLoanRow['data'];
  derived?: ImportLoanRow['derived'];
  /**
   * The schedule the row's terms produce. Present only when the row is valid,
   * so `confirm` persists the very plan the validator approved instead of
   * building a second one from re-read inputs.
   */
  schedule?: AmortizationResult;
}

/**
 * Normalize any cell/JSON value to the string the old `cell()` produced.
 *
 * The point is that `1200` (JSON) and `'1200'` (a spreadsheet cell) must reach
 * the rules — and the signature — as the same thing. Without this the two
 * callers would drift the moment one of them coerced differently, which is the
 * whole defect this validator was extracted to close.
 */
function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return String(o.result ?? '').trim();
    if ('text' in o) return String(o.text ?? '').trim();
  }
  return String(v).trim();
}

/**
 * A REAL calendar date, not merely a `YYYY-MM-DD`-shaped string.
 *
 * `new Date('2025-02-31')` does not fail — it rolls over to 3 March. The old
 * code therefore accepted the impossible date AND silently moved the loan's
 * disbursement by three days; the round-trip below is what catches it.
 */
function parseCalendarDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? d : null;
}

/** A real `YYYY-MM`. `2025-13` is shaped right and is not a month. */
function parseCalendarMonth(s: string): { year: number; month: number } | null {
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const [year, month] = s.split('-').map(Number);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * More decimals than the ledger can hold.
 *
 * Money columns are `Decimal(12,2)` and the amortizer works in integer minor
 * units, so a third decimal is not "nearly right" — it is rounded away and the
 * imported loan then disagrees with the spreadsheet it was migrated from, with
 * nothing anywhere saying so. Refusing is the only outcome that keeps the two
 * books equal. (OMR's baisa is the known casualty; that is a schema-wide
 * limitation, not one this importer can paper over.)
 */
function hasExcessDecimals(raw: string): boolean {
  const m = /^[+-]?\d*(?:\.(\d+))?$/.exec(raw.trim());
  const frac = m?.[1];
  if (!frac) return false;
  return frac.replace(/0+$/, '').length > 2;
}

/**
 * The key rows are signed with.
 *
 * `JWT_SECRET` is mandatory for the app to boot (`auth.module.ts` calls
 * `requireSecret`), so it is always there; a per-process random would be worse
 * than nothing, because every signature would die on restart and on the second
 * instance of a horizontally scaled deployment.
 */
function signingSecret(): string {
  const configured =
    process.env.LOAN_IMPORT_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!configured) {
    throw new Error(
      'LOAN_IMPORT_SIGNING_SECRET (or JWT_SECRET) is not set; loan import rows cannot be signed.',
    );
  }
  return configured;
}

/** HMAC over the NORMALIZED row, so a re-typed but identical row still matches. */
export function signRow(data: ImportLoanRow['data']): string {
  const canonical = JSON.stringify(
    SIGNED_FIELDS.map((k) => text((data as Record<string, unknown>)[k])),
  );
  return `v1.${createHmac('sha256', signingSecret()).update(canonical).digest('base64url')}`;
}

/** Constant-time compare, so the signature cannot be probed a byte at a time. */
export function verifyRowSignature(
  data: ImportLoanRow['data'],
  candidate: unknown,
): boolean {
  const given = text(candidate);
  if (!given) return false;
  const expected = signRow(data);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * THE row rulebook. One implementation, run by `preview` AND by `confirm`.
 *
 * It used to live inline in `preview`, which meant `confirm` — the endpoint
 * that actually creates loans — validated nothing at all: a client could
 * preview a clean 1,200/12 row and POST 750,000 over 240 instalments against
 * an employee no preview had ever seen, and get a live ACTIVE loan with
 * `approvalSource: 'IMPORT'`. Every rule below was, until this was extracted,
 * enforced in the browser only.
 *
 * Pure on purpose: no Prisma, no settings lookups, no `Date.now()` that a test
 * cannot pin. Everything variable arrives in `ctx`.
 */
export function validateImportRow(
  raw: RawImportRow,
  ctx: ImportRowContext,
): ImportRowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = ctx.now ?? new Date();

  const employeeCode = text(raw.employeeCode);
  const referenceNo = text(raw.referenceNo);
  const type = text(raw.type).toUpperCase();
  const principalRaw = text(raw.principal);
  const principal = Number(principalRaw);
  const interestMethod = (text(raw.interestMethod) || 'NONE').toUpperCase();
  const interestRateRaw = text(raw.interestRate);
  const interestRate = interestRateRaw === '' ? 0 : Number(interestRateRaw);
  const installments = Number(text(raw.installments));
  const emiRaw = text(raw.emi);
  const disbursedOn = text(raw.disbursedOn);
  const firstDeductionPeriod = text(raw.firstDeductionPeriod);
  const installmentsPaidRaw = text(raw.installmentsPaid);
  const installmentsPaid =
    installmentsPaidRaw === '' ? 0 : Number(installmentsPaidRaw);
  const amountRepaidRaw = text(raw.amountRepaid);
  const amountRepaid = amountRepaidRaw === '' ? 0 : Number(amountRepaidRaw);
  const status = (text(raw.status) || 'ACTIVE').toUpperCase();
  const notes = text(raw.notes);
  // Blank means MONTHLY — the value this importer used to hard-code for every
  // row, so an existing sheet keeps producing exactly the loans it did before.
  const deductionFrequency = (text(raw.deductionFrequency) || 'MONTHLY').toUpperCase();

  const employee = ctx.employee;
  if (!employeeCode) errors.push('Employee Code is required');
  else if (!employee) errors.push(`No employee with code ${employeeCode}`);

  if (!referenceNo) errors.push('Loan Reference No is required');
  else if (!/^[A-Za-z0-9/_-]{3,40}$/.test(referenceNo)) {
    errors.push('Loan Reference No must be 3-40 chars of letters, digits, / _ or -');
  } else if (ctx.refsInDb.has(referenceNo)) {
    errors.push(`Loan Reference No ${referenceNo} already exists`);
  } else if (ctx.refsSeen.has(referenceNo)) {
    errors.push(`Loan Reference No ${referenceNo} is duplicated in this file`);
  } else {
    ctx.refsSeen.add(referenceNo);
  }

  if (!['ADVANCE', 'LOAN'].includes(type)) errors.push('Type must be ADVANCE or LOAN');
  if (!Number.isFinite(principal) || principal <= 0) {
    errors.push('Principal Amount must be greater than 0');
  } else if (principal > 1e11) {
    errors.push('Principal Amount is implausibly large');
  } else if (hasExcessDecimals(principalRaw)) {
    errors.push('Principal Amount cannot have more than 2 decimal places');
  }

  if (!['NONE', 'FLAT', 'REDUCING_BALANCE'].includes(interestMethod)) {
    errors.push('Interest Method must be NONE, FLAT or REDUCING_BALANCE');
  } else if (interestMethod !== 'NONE' && !ctx.interestEnabled) {
    // The kill-switch, honoured here as a REFUSAL rather than as the silent
    // coercion to NONE that `LoanScheduleService.generate()` applies.
    //
    // The two paths are not the same problem. `generate()` is CREATING an
    // agreement, so forcing it to the deployment's policy is exactly right —
    // there is no other version of that loan to disagree with. An import is
    // REPRODUCING an agreement that already exists somewhere else, and whose
    // opening balance, instalments-paid and amount-repaid were all computed
    // WITH the interest. Dropping the interest silently would leave the
    // migrated loan owing a different total from the ledger it came out of and
    // nothing on the row would say so. Refusing puts the choice where it
    // belongs: enable interest, or restate the sheet without it.
    errors.push(
      `Interest is switched off in this system, so a loan with Interest Method ${interestMethod} cannot be imported. Turn on loan_interest_enabled or set the method to NONE.`,
    );
  }
  if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100) {
    errors.push('Annual Interest Rate must be between 0 and 100');
  }
  if (interestRate > 0 && interestMethod === 'NONE') {
    errors.push('An interest rate was given but the method is NONE');
  }

  const effectiveInstallments = type === 'ADVANCE' ? 1 : installments;
  if (!Number.isInteger(effectiveInstallments) || effectiveInstallments < 1) {
    errors.push('Total Installments must be a whole number of at least 1');
  } else if (type === 'LOAN' && effectiveInstallments > ctx.maxInstallments) {
    // Deliberately still a WARNING and not an error: an importer is migrating
    // history, and history is not subject to today's policy cap. The cap is a
    // rule for loans being FILED now.
    warnings.push(
      `Installments (${effectiveInstallments}) exceed the configured maximum of ${ctx.maxInstallments}`,
    );
  }

  const disbursed = parseCalendarDate(disbursedOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(disbursedOn)) {
    errors.push('Disbursed On must be YYYY-MM-DD');
  } else if (!disbursed) {
    errors.push('Disbursed On is not a real calendar date');
  } else {
    // Checked whether or not the employee resolved. It used to hang off
    // `else if (employee)`, so a row with an unknown code was never told its
    // date was in the future as well.
    if (disbursed.getTime() > now.getTime()) {
      errors.push('Disbursed On cannot be in the future');
    }
    if (employee?.startDate && disbursed < new Date(employee.startDate)) {
      errors.push('Disbursed On is before the employee joined');
    }
  }

  const firstPeriod = parseCalendarMonth(firstDeductionPeriod);
  if (!/^\d{4}-\d{2}$/.test(firstDeductionPeriod)) {
    errors.push('First Deduction Month must be YYYY-MM');
  } else if (!firstPeriod) {
    errors.push('First Deduction Month is not a real calendar month');
  } else if (disbursed) {
    // Cross-field, which nothing checked before: the two were shape-checked in
    // isolation, so a schedule's first instalment could fall due months before
    // the money was paid out. Same month is fine — money out on the 15th,
    // first deduction on the 30th is the ordinary case.
    const disbursedPeriod = disbursedOn.slice(0, 7);
    if (firstDeductionPeriod < disbursedPeriod) {
      errors.push('First Deduction Month is before Disbursed On');
    }
  }

  if (!Number.isInteger(installmentsPaid) || installmentsPaid < 0) {
    errors.push('Installments Already Paid must be 0 or more');
  } else if (installmentsPaid > effectiveInstallments) {
    errors.push('Installments Already Paid exceeds Total Installments');
  }
  if (!Number.isFinite(amountRepaid) || amountRepaid < 0) {
    errors.push('Amount Already Repaid must be 0 or more');
  } else if (amountRepaid > principal) {
    errors.push('Amount Already Repaid exceeds the principal');
  } else if (hasExcessDecimals(amountRepaidRaw)) {
    errors.push('Amount Already Repaid cannot have more than 2 decimal places');
  }
  if (!['ACTIVE', 'CLOSED', 'ON_HOLD'].includes(status)) {
    errors.push('Status must be ACTIVE, CLOSED or ON_HOLD');
  }
  if (!['MONTHLY', 'WEEKLY', 'QUARTERLY'].includes(deductionFrequency)) {
    errors.push('Deduction Frequency must be MONTHLY, WEEKLY or QUARTERLY');
  }

  // Derive the schedule with the SAME engine the normal flow uses.
  let derived: ImportLoanRow['derived'];
  let schedule: AmortizationResult | undefined;
  if (errors.length === 0) {
    try {
      const [y, m] = firstDeductionPeriod.split('-').map(Number);
      const result = generateSchedule({
        principal,
        annualRatePercent: interestMethod === 'NONE' ? 0 : interestRate,
        method: interestMethod as InterestMethod,
        installments: effectiveInstallments,
        frequency: deductionFrequency as Frequency,
        firstDueDate: new Date(Date.UTC(y, m, 0)),
      });

      const emi = roundMoney(result.levelEmi);
      // A supplied EMI is VALIDATED against the engine, never trusted: an
      // imported figure that disagrees means the terms disagree.
      if (emiRaw !== '') {
        const given = Number(emiRaw);
        if (!Number.isFinite(given)) {
          errors.push('EMI Amount is not a number');
        } else if (Math.abs(given - emi) > 1) {
          errors.push(
            `EMI Amount ${given} does not match the derived instalment of ${emi} for these terms`,
          );
        }
      }

      const consumed = result.rows.slice(0, installmentsPaid);
      const consumedPrincipal = roundMoney(
        consumed.reduce((a, r) => a + r.principalComponent, 0),
      );
      if (
        installmentsPaid > 0 &&
        amountRepaid > 0 &&
        Math.abs(consumedPrincipal - amountRepaid) > 1
      ) {
        warnings.push(
          `Amount Already Repaid (${amountRepaid}) differs from the ${installmentsPaid} consumed instalment(s) (${consumedPrincipal}); the difference will be booked as an import adjustment.`,
        );
      }

      const next = result.rows[installmentsPaid];
      derived = {
        emi,
        totalInterest: roundMoney(result.totalInterest),
        installmentsConsumed: installmentsPaid,
        openingOutstanding: roundMoney(principal - (amountRepaid || consumedPrincipal)),
        nextDuePeriod: next
          ? `${next.dueDate.getUTCFullYear()}-${String(next.dueDate.getUTCMonth() + 1).padStart(2, '0')}`
          : null,
      };
      if (errors.length === 0) schedule = result;
    } catch (err) {
      errors.push(
        err instanceof LoanAmortizationError
          ? err.message
          : 'Could not build a schedule for these terms',
      );
    }
  }

  return {
    errors,
    warnings,
    data: {
      employeeCode,
      referenceNo,
      type,
      principal,
      interestMethod,
      interestRate,
      installments: effectiveInstallments,
      emi: emiRaw === '' ? null : Number(emiRaw),
      disbursedOn,
      firstDeductionPeriod,
      installmentsPaid,
      amountRepaid,
      status,
      notes,
      deductionFrequency,
    },
    derived,
    schedule,
  };
}

/**
 * Bulk import of loans that already exist elsewhere — typically a migration
 * from a spreadsheet or a legacy system, mid-life and part repaid.
 *
 * Two details make or break this:
 *
 *  1. The schedule is generated by the SAME amortization engine the normal flow
 *     uses. A bespoke import calculator is exactly how imported balances start
 *     disagreeing with natively-created ones.
 *  2. Consumed instalments are written into `advance_loan_deductions` as PAID
 *     rows with `payrollItemId = null`. Payroll derives its pick-up from the
 *     ledger, so WITHOUT these rows an imported mid-life loan looks brand new
 *     and gets recovered from instalment 1 all over again.
 *
 * And one that makes or breaks its SECURITY: `preview` and `confirm` run the
 * same `validateImportRow`. `confirm` used to run nothing.
 */
@Injectable()
export class LoanImportService {
  private readonly logger = new Logger(LoanImportService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SystemSettingsService,
    // Only for `accruedUnpaidInterest`. The importer builds its own schedule
    // (it needs the mid-life PAID rows `generate()` knows nothing about), but
    // the meaning of `outstandingInterest` is that service's contract and must
    // not be re-implemented here — see the write below.
    private schedules: LoanScheduleService,
  ) {}

  async template(res: Response) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Loans');
    ws.addRow(HEADERS);
    ws.getRow(1).font = { bold: true };
    ws.columns = HEADERS.map(() => ({ width: 26 }));
    ws.addRow([
      'EMP-001',
      'LN-2026-0001',
      'LOAN',
      120000,
      'REDUCING_BALANCE',
      12,
      12,
      '',
      '2026-01-15',
      '2026-02',
      3,
      30000,
      'ACTIVE',
      'Migrated from legacy system',
    ]);

    const ref = wb.addWorksheet('Reference');
    ref.addRow(['Field', 'Allowed values']);
    ref.getRow(1).font = { bold: true };
    ref.addRow(['Type', 'ADVANCE, LOAN']);
    ref.addRow(['Interest Method', 'NONE, FLAT, REDUCING_BALANCE']);
    ref.addRow(['Status', 'ACTIVE, CLOSED, ON_HOLD']);
    ref.addRow(['EMI Amount', 'Leave blank to let the system derive it']);
    ref.columns = [{ width: 24 }, { width: 60 }];

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=loan_import_template.xlsx',
    );
    const buffer = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  }

  /** `advance_loan_max_installments` and `loan_interest_enabled`, once. */
  private async policy(): Promise<Pick<ImportRowContext, 'maxInstallments' | 'interestEnabled'>> {
    const [maxInstallmentsRaw, interestRaw] = await Promise.all([
      this.settings.getSetting('advance_loan_max_installments', '12'),
      this.settings.getSetting('loan_interest_enabled', 'false'),
    ]);
    return {
      maxInstallments: Number(maxInstallmentsRaw) || 12,
      interestEnabled: interestRaw === 'true',
    };
  }

  /**
   * Header comparison is whitespace- and case-insensitive but ORDER-sensitive.
   *
   * The parser reads cells by POSITION, so a sheet whose columns were moved is
   * parsed as though they had not been — a principal read as an interest rate,
   * a reference number read as an employee code — and the operator's first sign
   * of trouble is a live loan with the wrong terms. Refusing the FILE is the
   * only honest answer: every row on it is misread, so per-row errors would
   * just be fourteen wrong sentences.
   */
  private assertHeaderRow(ws: ExcelJS.Worksheet) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const header = ws.getRow(1);
    for (let i = 0; i < HEADERS.length; i++) {
      const actual = text(header.getCell(i + 1).value);
      if (norm(actual) !== norm(HEADERS[i])) {
        throw new BadRequestException(
          `The header row does not match the import template: column ${i + 1} should be "${HEADERS[i]}" but is "${actual}". Download a fresh template and keep its columns in order.`,
        );
      }
    }
  }

  /** Parse + validate, persisting nothing. */
  async preview(filePath: string) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(filePath);
    } catch (err) {
      // ExcelJS throws a plain `Error` on a buffer that is not a workbook, and
      // a plain Error is a 500 `Internal server error` — indistinguishable, to
      // the operator and to a monitor, from the backend falling over. It is a
      // bad upload, and it says so.
      this.logger.warn(
        `Loan import file could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        'That file could not be read as an Excel workbook. Re-save it as .xlsx and upload it again.',
      );
    }
    const ws = wb.getWorksheet('Loans') ?? wb.worksheets[0];
    if (!ws) throw new BadRequestException('The workbook has no worksheet');

    const rows: ImportLoanRow[] = [];

    // A worksheet with no cells at all is an EMPTY sheet, not a broken one —
    // there is no header row to disagree with, and the operator is told they
    // imported nothing rather than that their template is wrong.
    let anyContent = false;
    ws.eachRow((row) => {
      if (HEADERS.some((_, i) => text(row.getCell(i + 1).value) !== '')) {
        anyContent = true;
      }
    });
    if (!anyContent) {
      return {
        success: true,
        summary: { totalRows: 0, validRows: 0, invalidRows: 0 },
        rows,
      };
    }
    this.assertHeaderRow(ws);

    // Prefetch everything the row loop needs, or this is an N+1 per column.
    const [employees, existingRefs, policy] = await Promise.all([
      this.prisma.employee.findMany({
        select: { id: true, employeeCode: true, startDate: true, endDate: true, status: true },
      }),
      this.prisma.advanceLoanRequest.findMany({
        where: { referenceNo: { not: null } },
        select: { referenceNo: true },
      }),
      this.policy(),
    ]);
    const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
    const refsInDb = new Set(
      existingRefs.map((r) => r.referenceNo).filter((r): r is string => !!r),
    );
    const refsSeen = new Set<string>();
    const now = new Date();

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const cell = (i: number) => row.getCell(i).value;
      if (HEADERS.every((_, i) => text(cell(i + 1)) === '')) return; // blank row

      const raw: RawImportRow = {
        employeeCode: cell(1),
        referenceNo: cell(2),
        type: cell(3),
        principal: cell(4),
        interestMethod: cell(5),
        interestRate: cell(6),
        installments: cell(7),
        emi: cell(8),
        disbursedOn: cell(9),
        firstDeductionPeriod: cell(10),
        installmentsPaid: cell(11),
        amountRepaid: cell(12),
        status: cell(13),
        notes: cell(14),
        deductionFrequency: cell(15),
      };

      const result = validateImportRow(raw, {
        employee: byCode.get(text(raw.employeeCode)),
        refsInDb,
        refsSeen,
        now,
        ...policy,
      });
      const valid = result.errors.length === 0;

      rows.push({
        rowNumber,
        valid,
        errors: result.errors,
        warnings: result.warnings,
        // Only a row the server called valid is signed, so a client cannot
        // confirm an invalid row by echoing back a signature it never got.
        data: valid
          ? { ...result.data, signature: signRow(result.data) }
          : result.data,
        derived: result.derived,
      });
    });

    return {
      success: true,
      summary: {
        totalRows: rows.length,
        validRows: rows.filter((r) => r.valid).length,
        invalidRows: rows.filter((r) => !r.valid).length,
      },
      rows,
    };
  }

  /**
   * Create the validated rows.
   *
   * Per loan: one transaction, all-or-nothing. Across loans: a plain loop with
   * per-row results — one bad row must not roll back 1,999 good ones, but a
   * half-written loan is unacceptable.
   *
   * EVERY row is re-validated here by `validateImportRow`, the same function
   * `preview` runs. A row that fails becomes a FAILED RESULT, not a loan —
   * `results[]` is the contract, so refusing the whole batch for one bad row
   * would cost an operator the other 1,999.
   *
   * Re-validation is the floor, not the ceiling: it cannot tell 1,200 from a
   * mutated 750,000, because both are figures an operator could legitimately
   * have in a sheet. That is what the preview signature is for.
   */
  async confirm(rows: RawImportRow[], user: any) {
    const codes = rows.map((r) => text(r.employeeCode)).filter(Boolean);
    const refs = rows.map((r) => text(r.referenceNo)).filter(Boolean);

    const [employees, existingRefs, policy, requireSignatureRaw] = await Promise.all([
      this.prisma.employee.findMany({
        where: { employeeCode: { in: codes } },
        select: { id: true, employeeCode: true, fullName: true, startDate: true },
      }),
      this.prisma.advanceLoanRequest.findMany({
        where: { referenceNo: { in: refs } },
        select: { referenceNo: true },
      }),
      this.policy(),
      this.settings.getSetting('loan_import_require_preview_signature', 'false'),
    ]);
    const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
    const refsInDb = new Set(
      existingRefs.map((r) => r.referenceNo).filter((r): r is string => !!r),
    );
    const refsSeen = new Set<string>();
    const now = new Date();

    // Off by default so an API client that builds rows directly still works.
    // Turn it on and `confirm` accepts NOTHING that a preview did not produce,
    // which is the only way to refuse a mutation whose new value is itself
    // within the rules.
    const requireSignature = requireSignatureRaw === 'true';

    const importBatchId = crypto.randomUUID();
    const results: Array<{
      referenceNo: string;
      success: boolean;
      loanId?: string;
      error?: string;
      errors?: string[];
      warnings?: string[];
    }> = [];

    // Validate the whole batch FIRST, sharing one `refsSeen`, so a reference
    // duplicated inside the batch is caught deterministically rather than by
    // whichever row happened to reach the unique index first.
    const checked = rows.map((raw) => {
      const validation = validateImportRow(raw, {
        employee: byCode.get(text(raw.employeeCode)),
        refsInDb,
        refsSeen,
        now,
        ...policy,
      });

      const signature = text(raw.signature);
      if (validation.errors.length === 0) {
        if (signature) {
          if (!verifyRowSignature(validation.data, signature)) {
            validation.errors.push(
              'This row was changed after it was previewed. Preview the file again and confirm the rows it returns.',
            );
          }
        } else if (requireSignature) {
          validation.errors.push(
            'This row was not produced by a preview. Preview the file and confirm the rows it returns.',
          );
        }
      }
      return validation;
    });

    for (const validation of checked) {
      const row = validation.data;

      if (validation.errors.length > 0) {
        results.push({
          referenceNo: row.referenceNo,
          success: false,
          // Kept as a single sentence for the existing modal, which renders
          // `error`; the full list is alongside it for anything newer.
          error: validation.errors.join(' '),
          errors: validation.errors,
          warnings: validation.warnings,
        });
        continue;
      }

      try {
        const employee = byCode.get(row.employeeCode);
        // Unreachable — the validator already refused an unresolved code — but
        // the compiler does not know that and neither would a future edit.
        if (!employee) throw new Error(`No employee with code ${row.employeeCode}`);

        // The plan the VALIDATOR approved, not a second one built from re-read
        // inputs: two derivations are two chances to disagree.
        const schedule = validation.schedule!;

        const consumed = schedule.rows.slice(0, row.installmentsPaid);
        const consumedPrincipal = roundMoney(
          consumed.reduce((a, r) => a + r.principalComponent, 0),
        );
        const consumedInterest = roundMoney(
          consumed.reduce((a, r) => a + r.interestComponent, 0),
        );
        // Keep SUM(paid) === amountRepaid exactly, or every report disagrees
        // with the loan it is reporting on.
        const adjustment = roundMoney(
          (row.amountRepaid || consumedPrincipal) - consumedPrincipal,
        );

        const loanId = await this.prisma.$transaction(async (tx) => {
          const loan = await tx.advanceLoanRequest.create({
            data: {
              employeeId: employee.id,
              type: row.type,
              amount: row.principal,
              installments: row.installments,
              installmentAmount: schedule.levelEmi,
              // Imported loans bypass approval: they were approved elsewhere.
              status: row.status === 'CLOSED' ? 'CLOSED' : row.status,
              approvalSource: 'IMPORT',
              approvedAt: new Date(row.disbursedOn),
              approverId: user?.id ?? null,
              referenceNo: row.referenceNo,
              interestMethod: row.interestMethod as any,
              interestRate: row.interestRate,
              // Was hard-coded MONTHLY here and in `preview`, so a weekly or
              // quarterly loan being migrated silently became a monthly one —
              // its schedule then disagreed with the ledger it came from.
              deductionFrequency: (row.deductionFrequency ?? 'MONTHLY') as any,
              disbursementDate: new Date(row.disbursedOn),
              effectiveDate: new Date(row.disbursedOn),
              firstDeductionDate: schedule.rows[0]?.dueDate,
              amountRepaid: roundMoney(consumedPrincipal + adjustment),
              interestPaid: consumedInterest,
              outstandingPrincipal: roundMoney(
                row.principal - consumedPrincipal - adjustment,
              ),
              // Refreshed below, once the schedule rows it is derived from
              // exist. It CANNOT be computed here: `outstandingInterest` is
              // accrued-and-unpaid interest read off the live plan, and the
              // plan is not persisted yet.
              outstandingInterest: 0,
              // Lifetime SCHEDULED interest, snapshotted for reporting — the
              // same split `LoanScheduleService.generate()` writes. Despite the
              // name it is NOT "accrued to date"; `outstandingInterest` is.
              interestAccrued: schedule.totalInterest,
              totalPayable: schedule.totalPayable,
              scheduleVersion: 1,
              importBatchId,
              openingPrincipal: row.principal,
              openingRepaid: row.amountRepaid,
              employeeCodeSnapshot: employee.employeeCode,
              employeeNameSnapshot: employee.fullName,
              reason: row.notes || 'Imported',
            },
          });

          await tx.loanSchedule.createMany({
            data: schedule.rows.map((r, idx) => {
              const dueMonth = r.dueDate.getUTCMonth() + 1;
              const dueYear = r.dueDate.getUTCFullYear();
              const isPaid = idx < row.installmentsPaid;
              return {
                requestId: loan.id,
                version: 1,
                installmentNo: r.installmentNo,
                dueDate: r.dueDate,
                dueCycleKey: LoanRecoveryService.cycleKey(dueMonth, dueYear),
                dueMonth,
                dueYear,
                openingBalance: r.openingBalance,
                principalComponent: r.principalComponent,
                interestComponent: r.interestComponent,
                employerSubsidyComponent: r.employerSubsidyComponent,
                feeComponent: r.feeComponent,
                emiAmount: r.emiAmount,
                closingBalance: r.closingBalance,
                status: isPaid ? 'PAID' : 'SCHEDULED',
                paidAmount: isPaid ? r.emiAmount : 0,
                paidPrincipal: isPaid ? r.principalComponent : 0,
                paidInterest: isPaid ? r.interestComponent : 0,
                settledAt: isPaid ? new Date(row.disbursedOn) : null,
                note: isPaid ? 'Imported as already paid' : null,
              };
            }),
          });

          // `outstandingInterest` is EMPLOYEE-BORNE INTEREST ACCRUED AND STILL
          // UNPAID, not the loan's remaining lifetime interest — the contract
          // is documented at the top of `LoanScheduleService`, and reading the
          // live plan is the only implementation of it. This used to write
          // `schedule.totalInterest - consumedInterest`, a lifetime figure, so
          // a loan imported with its first deduction still in the future
          // claimed a large accrued balance on interest nobody had earned yet.
          // `loan-settlement.service.ts` reads this column directly, so that
          // was the §1 over-quote arriving on the exit path.
          //
          // Called with `tx`, so it reads the rows created two statements above
          // inside this same uncommitted transaction; `version: 1` because an
          // imported loan is always created at schedule version 1. `asOf` is
          // the batch clock, so 2,000 rows cannot straddle midnight and give
          // two loans of identical terms two different opening figures.
          //
          // Non-zero only where the import genuinely is in arrears: the
          // backfilled rows are written PAID (and PAID is outside the
          // COLLECTABLE set the accrual reads), so what remains is SCHEDULED
          // rows whose due date has already passed — a mid-life loan carrying
          // more elapsed instalments than the sheet marked repaid.
          const accruedInterest = await this.schedules.accruedUnpaidInterest(
            loan.id,
            { version: 1, asOf: now },
            tx,
          );
          await tx.advanceLoanRequest.update({
            where: { id: loan.id },
            data: { outstandingInterest: accruedInterest },
          });

          // THE detail that makes an imported mid-life loan behave: payroll
          // reads the LEDGER, so without PAID history rows it would restart at
          // instalment 1 and recover the loan twice.
          if (row.installmentsPaid > 0) {
            const created = await tx.loanSchedule.findMany({
              where: { requestId: loan.id, version: 1 },
              orderBy: { installmentNo: 'asc' },
              take: row.installmentsPaid,
              select: { id: true, dueMonth: true, dueYear: true },
            });
            await tx.advanceLoanDeduction.createMany({
              data: created.map((s, idx) => ({
                requestId: loan.id,
                scheduleId: s.id,
                payrollItemId: null,
                amount: consumed[idx].emiAmount,
                principalComponent: consumed[idx].principalComponent,
                interestComponent: consumed[idx].interestComponent,
                feeComponent: consumed[idx].feeComponent,
                month: s.dueMonth,
                year: s.dueYear,
                status: 'PAID',
                outcome: 'FULL',
                reason: 'AFFORDABLE',
              })),
            });
          }

          await tx.loanTransaction.create({
            data: {
              requestId: loan.id,
              type: 'DISBURSEMENT',
              transactionDate: new Date(row.disbursedOn),
              amount: row.principal,
              principalComponent: row.principal,
              createdById: user?.id ?? null,
              narration: `Imported (batch ${importBatchId})`,
            },
          });

          if (Math.abs(adjustment) > 0.005) {
            await tx.loanTransaction.create({
              data: {
                requestId: loan.id,
                type: 'ADJUSTMENT',
                transactionDate: new Date(row.disbursedOn),
                amount: Math.abs(adjustment),
                principalComponent: Math.abs(adjustment),
                createdById: user?.id ?? null,
                narration:
                  'Import reconciliation: opening repaid differed from the consumed instalments',
              },
            });
          }

          return loan.id;
        });

        results.push({
          referenceNo: row.referenceNo,
          success: true,
          loanId,
          warnings: validation.warnings,
        });
      } catch (err) {
        results.push({
          referenceNo: row.referenceNo,
          success: false,
          error: this.rowFailureMessage(err, row.referenceNo, importBatchId),
        });
      }
    }

    return {
      success: true,
      importBatchId,
      summary: {
        total: rows.length,
        imported: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
      results,
    };
  }

  /**
   * An operator-readable sentence for a row that blew up while being written.
   *
   * `results[].error` used to be the raw thrown message, which for Prisma means
   * the absolute path of the checkout and an excerpt of the source around the
   * failing call — straight past `AllExceptionsFilter`, which scrubs exactly
   * that and only sees exceptions that reach it. Per-row errors never do. The
   * detail still exists; it goes to the server log, where it is useful.
   */
  private rowFailureMessage(
    err: unknown,
    referenceNo: string,
    importBatchId: string,
  ): string {
    this.logger.error(
      `Loan import row ${referenceNo} failed (batch ${importBatchId})`,
      err instanceof Error ? err.stack : String(err),
    );

    if (err instanceof LoanAmortizationError) return err.message;
    if (err instanceof BadRequestException) return err.message;

    // Prisma's known request errors carry a stable code; the two that a row can
    // realistically provoke get a sentence of their own, because "already
    // exists" is something an operator can act on and "logged" is not.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      return `Loan Reference No ${referenceNo} already exists`;
    }
    if (code === 'P2003') {
      return `This row refers to a record that no longer exists. Preview the file again and confirm the rows it returns.`;
    }

    return `This row could not be imported. The technical detail has been recorded in the server log against import batch ${importBatchId}.`;
  }
}
