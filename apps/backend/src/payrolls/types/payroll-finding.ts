/**
 * A problem found before a payroll is generated.
 *
 * Shaped identically to `src/wps/types/wps-finding.ts`, deliberately: the WPS
 * pre-flight already solved "tell an operator what is wrong, per employee, with
 * a link to the screen that fixes it", and having two shapes would mean two
 * screen components and two ways of being inconsistent.
 *
 * BLOCKING means generation is refused. WARNING means it proceeds, and the
 * operator was told.
 */
export type FindingSeverity = 'BLOCKING' | 'WARNING';

export interface PayrollFinding {
  /** Stable machine code. Never localise — the prose lives in `message`. */
  code: string;
  severity: FindingSeverity;
  scope: 'RUN' | 'EMPLOYEE';
  message: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  /** The thing that is wrong: 'attendance' | 'bankDetail' | 'contract'. */
  field?: string;
  /** Deep link to the screen that fixes it. */
  fix?: { label: string; href: string };
}

export interface PayrollEmployeeStatus {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  status: 'READY' | 'WARNING' | 'BLOCKED';
  findings: PayrollFinding[];
}

export interface PayrollPreflightResult {
  branchId: string | null;
  month: number;
  year: number;
  runType: string;

  /** "94 of 100 employees ready" — the headline. */
  ready: number;
  total: number;
  blockedEmployees: number;
  warningEmployees: number;

  /**
   * All-or-nothing, exactly as the WPS pre-flight is: true only when there is
   * ZERO blocking anywhere. Half a payroll is not a useful thing to produce.
   */
  canGenerate: boolean;

  runFindings: PayrollFinding[];
  byEmployee: PayrollEmployeeStatus[];

  /** WARNING codes the caller must acknowledge to proceed. */
  requiresAcknowledgement: string[];

  /** The period window, so the screen can show what it validated against. */
  window: {
    periodStart: string;
    periodEnd: string;
    cutOffDate: string | null;
    paymentDate: string | null;
    enforceCutOff: boolean;
    fromCalendar: boolean;
  };
}
