import { WpsMoney } from '../wps-money.util';

/**
 * The format-agnostic payload the core assembles and hands to a format adapter.
 *
 * Everything an adapter could need is here, already validated and already in
 * minor units, so an adapter is pure formatting: no DB, no clock, no config
 * lookups. That is what keeps "add a country" to one file.
 */

export interface WpsEmployer {
  /** Snapshot of WpsEmployerProfile.data, keyed by format.employerConfigSchema[].name. */
  data: Record<string, string>;
  legalName: string;
  country: string; // ISO-2
}

export interface WpsBankAccount {
  bankId: string;
  bankName: string;
  /** Bank.bankCode. Nullable in the schema — the adapter decides whether that blocks. */
  bankCode: string | null;
  swift: string | null;
  country: string;
  /** The full validated EmployeeBankDetail.data, keyed by CountryBankingField.fieldKey. */
  fields: Record<string, string>;
  /** Convenience projections of the common keys. */
  iban: string | null;
  accountNumber: string | null;
  accountHolderName: string | null;
  bankDetailId: string;
}

export interface WpsIdentifierValue {
  number: string;
  expiryDate: Date | null;
}

export interface WpsEmployeeRow {
  employeeId: string;
  payrollItemId: string;
  employeeCode: string;
  fullName: string;
  /**
   * Government identifiers, keyed by LegalDocumentCategory — only the categories
   * this format asked for via `requiredIdentifiers`.
   *
   * Note: Employee.idCard is deliberately NOT offered here. The onboarding UI sets
   * it to employeeCode, so it is an internal code, not a government number.
   */
  identifiers: Record<string, WpsIdentifierValue>;
  startDate: Date;
  endDate: Date | null;
  salaryType: 'MONTHLY' | 'DAILY';
  nationality: string | null;

  /** Never null by the time an adapter sees it — a missing account blocks earlier. */
  bank: WpsBankAccount;

  // Money — all already in minor units.
  /** PayrollItem.baseSalary: the EARNED basic for the period, not the contract rate. */
  basic: WpsMoney;
  /** allowances + foodAllowance + bonus + overtimePay + reimbursement. */
  allowances: WpsMoney;
  /** deduction + advanceLoanDeduction + insurance + tax. */
  deductions: WpsMoney;
  net: WpsMoney;
  /** Derived: basic + allowances. There is no gross column on PayrollItem. */
  gross: WpsMoney;

  workDays: number;
  actualWorkDays: number;
  /** Days not worked in the period, when the format must report them. */
  lopDays: number;

  /** Escape hatch so an adapter can carry extras without a core change. */
  extra: Record<string, unknown>;
}

export interface WpsRunPayload {
  /** The already-allocated WpsFile.id, so an adapter can put it in the filename. */
  runId: string;
  version: number;
  format: string;
  specVersion: string;

  branch: { id: string; code: string; name: string; country: string };
  employer: WpsEmployer;

  period: { month: number; year: number; startDate: Date; endDate: Date };
  /** From runOptions, defaulted to the period end. */
  paymentDate: Date;

  payroll: { id: string; version: number; lockedAt: Date; approvedAt: Date };

  rows: WpsEmployeeRow[];
  /**
   * Sum of rows[].net — computed from the rows themselves, NEVER read from
   * payrolls.total_amount, so the header always reconciles with the detail.
   */
  total: WpsMoney;

  currency: string;
  currencyExponent: number;

  /** Validated against format.runOptionsSchema. Read via optRun(). */
  runOptions: Record<string, unknown>;

  generatedAt: Date;
  generatedBy: { userId: string; name: string };
}

/**
 * Typed read of a run option with a fallback — mirrors `opt()` in the attendance
 * provider framework so adapters never cast.
 */
export function optRun<T extends string | number | boolean>(
  payload: WpsRunPayload,
  key: string,
  fallback: T,
): T {
  const v = payload.runOptions?.[key];
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof fallback === 'number') {
    const n = Number(v);
    return (Number.isFinite(n) ? n : fallback) as T;
  }
  if (typeof fallback === 'boolean') {
    return (v === true || v === 'true') as T;
  }
  return String(v) as T;
}
