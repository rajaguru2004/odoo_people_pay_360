export type AdvanceLoanType = 'ADVANCE' | 'LOAN';

/**
 * v2 widened this set. DRAFT/DISBURSED/ACTIVE/ON_HOLD/CLOSED/WRITTEN_OFF/
 * RECEIVABLE/SETTLED are new; APPROVED and COMPLETED keep their old meaning so
 * pre-v2 rows render unchanged.
 */
export type AdvanceLoanStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'DISBURSED'
  | 'ACTIVE'
  | 'ON_HOLD'
  | 'CLOSED'
  | 'WRITTEN_OFF'
  | 'RECEIVABLE'
  | 'SETTLED'
  | 'COMPLETED';

export type LoanInterestMethod = 'NONE' | 'FLAT' | 'REDUCING_BALANCE';

export type LoanScheduleStatus =
  | 'SCHEDULED'
  | 'PARTIAL'
  | 'PAID'
  | 'DEFERRED'
  | 'SKIPPED'
  | 'WAIVED'
  | 'WRITTEN_OFF'
  | 'CLOSED_EARLY'
  | 'CANCELLED';

/** One planned instalment of the amortization schedule. */
export interface LoanScheduleRow {
  id: string;
  installmentNo: number;
  dueDate: string;
  dueMonth: number;
  dueYear: number;
  openingBalance: string | number;
  principalComponent: string | number;
  interestComponent: string | number;
  employerSubsidyComponent: string | number;
  feeComponent: string | number;
  emiAmount: string | number;
  closingBalance: string | number;
  status: LoanScheduleStatus;
  paidAmount: string | number;
  settledAt?: string | null;
  note?: string | null;
}

export interface LoanPayoffQuote {
  loanId: string;
  status: AdvanceLoanStatus;
  outstandingPrincipal: number;
  outstandingInterest: number;
  payoffAmount: number;
  asOf: string;
}

/** One rule evaluated by the eligibility gate. */
export interface EligibilityCheck {
  code: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail?: string;
  limit?: number | string | null;
  actual?: number | string | null;
}

export interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  maxEligibleAmount: number | null;
  monthlyNet: number;
  existingEmis: number;
}

export interface AdvanceLoanAttachment {
  id: string;
  requestId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number | null;
  mimeType: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  uploader?: {
    id: string;
    email: string;
    employee?: { fullName: string; avatarUrl?: string | null } | null;
  } | null;
}

export interface AdvanceLoanDeduction {
  id: string;
  requestId: string;
  payrollItemId: string | null;
  scheduleId?: string | null;
  amount: string | number;
  principalComponent?: string | number;
  interestComponent?: string | number;
  feeComponent?: string | number;
  plannedAmount?: string | number | null;
  shortfallAmount?: string | number;
  /** FULL | PARTIAL | DEFER | SKIP | HOLD */
  outcome?: string | null;
  /** Why this cycle recovered what it did. */
  reason?: string | null;
  month: number;
  year: number;
  /** SKIPPED rows are explanatory zero-amount entries, not payments. */
  status: 'PENDING' | 'PAID' | 'SKIPPED' | 'REVERSED' | 'VOID';
  createdAt: string;
}

export interface AdvanceLoanRequest {
  id: string;
  employeeId: string;
  type: AdvanceLoanType;
  amount: string | number;
  reason?: string | null;
  status: AdvanceLoanStatus;
  installments: number;
  installmentAmount?: string | number | null;
  amountRepaid: string | number;
  outstandingBalance?: number;
  approverId?: string | null;
  approvedAt?: string | null;
  approverRemarks?: string | null;
  rejectedReason?: string | null;
  completedAt?: string | null;

  // ── v2 ────────────────────────────────────────────────────────────────
  referenceNo?: string | null;
  currency?: string;
  interestMethod?: LoanInterestMethod;
  interestRate?: string | number;
  /**
   * Security held against the loan, in major units.
   *
   * Written at filing from the product's `requiresSecurity` and the
   * company-wide `loan_security_deposit_percent`; 0 on everything else.
   */
  securityDeposit?: string | number;
  outstandingPrincipal?: string | number | null;
  outstandingInterest?: string | number;
  interestPaid?: string | number;
  writtenOffAmount?: string | number;
  waivedAmount?: string | number;
  totalPayable?: string | number | null;
  priority?: number;
  holdUntil?: string | null;
  holdReason?: string | null;
  closureType?: string | null;
  closedAt?: string | null;
  closureRemarks?: string | null;
  scheduleVersion?: number;
  disbursementDate?: string | null;
  firstDeductionDate?: string | null;

  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    email: string;
    departmentId?: string;
    department?: { id: string; name: string } | null;
  };
  approver?: {
    id: string;
    email: string;
    employee?: { fullName: string } | null;
  } | null;
  deductions?: AdvanceLoanDeduction[];
  attachments?: AdvanceLoanAttachment[];
}

export interface CreateAdvanceLoanData {
  type: AdvanceLoanType;
  amount: number;
  reason?: string;
  installments?: number;
  /** Product to borrow under. Its terms are copied onto the loan at filing. */
  loanTypeId?: string;
  /** Ignored while `loan_interest_enabled` is off — the server refuses a rate outright. */
  interestMethod?: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  interestRate?: number;
  deductionFrequency?: 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';
  gracePeriods?: number;
  /** Blank/omitted means today. Bounded server-side by the backdating window. */
  effectiveDate?: string;
}

/**
 * A loan product.
 *
 * Only the fields the request form and the admin screen actually read are
 * modelled — the server carries roughly twenty-five terms, and typing all of
 * them here would invite the UI to display numbers it does not explain.
 */
export interface LoanType {
  id: string;
  code: string;
  name: string;
  category: AdvanceLoanType;
  isActive: boolean;
  sortOrder: number;
  branchId: string | null;
  branch?: { id: string; code: string; name: string } | null;

  interestMethod: 'NONE' | 'FLAT' | 'REDUCING_BALANCE';
  interestRate: string | number;
  deductionFrequency: 'MONTHLY' | 'WEEKLY' | 'QUARTERLY';
  defaultInstallments: number;
  maxInstallments: number;
  processingFeePercent: string | number;
  processingFeeFlat: string | number;
  processingFeeMode: 'DEDUCT_FROM_DISBURSEMENT' | 'ADD_TO_FIRST_EMI' | 'CAPITALIZE';
  employerSubsidyPercent: string | number;
  gracePeriods: number;
  graceMode: 'NONE' | 'MORATORIUM_FULL' | 'MORATORIUM_INTEREST_ONLY';

  maxAmount: string | number | null;
  maxMultipleOfSalary: string | number | null;
  minServiceMonths: number;
  maxActiveLoans: number;
  minNetSalaryAfterEmi: string | number | null;
  maxEmiPercentOfNet: string | number | null;
  minEmiAmount: string | number | null;
  requiresSecurity: boolean;
  eligiblePositions: string[];
  eligibleEmploymentTypes: string[];
  priority: number;
  pauseOnUnpaidLeave: boolean;
  allowPrepayment: boolean;
  allowWriteOff: boolean;
}

/** Paginated list envelope. Returned only when page/limit are supplied. */
export interface PaginatedLoans {
  success: boolean;
  data: AdvanceLoanRequest[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  summary: { count: number; totalPrincipal: number; totalOutstanding: number };
}

export interface LoanReportMeta {
  asOf: string;
  basis: 'LOCKED';
  openPayrolls: Array<{ id: string; month: number; year: number; status: string }>;
  note?: string;
}

export interface OutstandingRow {
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
  /** Sitting in an unlocked payroll — NOT yet deducted. */
  inFlight: number;
}

export interface EmiDueRow {
  scheduleId: string;
  loanId: string;
  referenceNo: string | null;
  type: string;
  employeeCode: string;
  employeeName: string;
  installmentNo: number;
  dueDate: string;
  emiAmount: number;
  principal: number;
  interest: number;
  alreadyPaid: number;
  status: string;
}

export interface OverdueRow {
  scheduleId: string;
  loanId: string;
  referenceNo: string | null;
  employeeCode: string;
  employeeName: string;
  installmentNo: number;
  dueDate: string;
  overdueDays: number;
  bucket: '1-30' | '31-60' | '61-90' | '90+';
  amountDue: number;
}

export interface ImportPreviewRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
  data: Record<string, any>;
  derived?: {
    emi: number;
    totalInterest: number;
    installmentsConsumed: number;
    openingOutstanding: number;
    nextDuePeriod: string | null;
  };
}

// ── Final settlement ────────────────────────────────────────────────────────

/** What may be decided about one outstanding loan when an employee leaves. */
export type SettlementAction =
  | 'RECOVER_FROM_FINAL_PAY'
  | 'RECOVER_FROM_GRATUITY'
  | 'RECOVER_FROM_LEAVE_ENCASHMENT'
  | 'PARTIAL'
  | 'WAIVE'
  | 'WRITE_OFF'
  | 'CARRY_AS_RECEIVABLE';

export interface SettlementQuoteItem {
  loanId: string;
  type: AdvanceLoanType;
  referenceNo: string | null;
  status: AdvanceLoanStatus;
  principal: number;
  interest: number;
  total: number;
}

export interface SettlementQuote {
  employeeId: string;
  loans: SettlementQuoteItem[];
  totalOutstanding: number;
  /** True when nothing is owed — the exit is not blocked by loans. */
  cleared: boolean;
}

export interface SettlementDecision {
  loanId: string;
  action: SettlementAction;
  /** PARTIAL only. */
  amount?: number;
  reference?: string;
  reason?: string;
}

export interface SettlementResult {
  settlementId: string;
  totalOutstanding: number;
  recovered: number;
  waived: number;
  writtenOff: number;
  carried: number;
}

export interface ReceivableLoan {
  id: string;
  referenceNo: string | null;
  amount: string | number;
  amountRepaid: string | number;
  outstandingPrincipal: string | number | null;
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    status: string;
  };
}
