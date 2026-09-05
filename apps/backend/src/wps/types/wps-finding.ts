/**
 * A single problem the pre-flight found.
 *
 * BLOCKING means no file is produced at all. That is deliberate and not
 * configurable: half a wage file is worse than none, because the bank rejects the
 * whole submission and the employer is non-compliant anyway.
 */
export type WpsSeverity = 'BLOCKING' | 'WARNING';

export interface WpsFinding {
  /** Stable machine code. Never localise — the prose lives in `message`. */
  code: string;
  severity: WpsSeverity;
  scope: 'RUN' | 'EMPLOYER' | 'EMPLOYEE';
  message: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  /** Field the problem is on: 'iban' | 'molEstablishmentNumber' | 'LABOUR_CARD'. */
  field?: string;
  /**
   * Deep link to the screen that fixes it. Filled by the CORE, never by a format
   * adapter — adapters must not know frontend routes.
   */
  fix?: { label: string; href: string };
}

export interface WpsEmployeeStatus {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  status: 'READY' | 'WARNING' | 'BLOCKED';
  findings: WpsFinding[];
}

export interface WpsPreflightResult {
  payrollId: string;
  branchId: string;
  branchCode: string;
  format: string;
  formatName: string;
  specVersion: string;
  currency: string;
  period: { month: number; year: number };

  /** "94 of 100 employees ready" — the headline number on the screen. */
  ready: number;
  total: number;
  blockedEmployees: number;
  warningEmployees: number;

  /** All-or-nothing: true only when there is ZERO blocking anywhere. */
  canGenerate: boolean;

  /** RUN + EMPLOYER scope problems (payroll not locked, employer fields missing…). */
  runFindings: WpsFinding[];
  byEmployee: WpsEmployeeStatus[];

  /** WARNING codes the caller must echo back to generate. */
  requiresAcknowledgement: string[];

  /** Preview of what the file's header total would be. */
  totalPreview: { minor: string; formatted: string; currency: string };
}
