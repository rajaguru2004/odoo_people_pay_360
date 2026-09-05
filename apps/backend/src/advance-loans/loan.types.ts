/**
 * Loan & Advances v2 — shared string unions and recovery contracts.
 *
 * `advance_loan_requests.status` and `.type` stay VarChar in the DB with a CHECK
 * constraint rather than becoming Prisma enums: converting them is an
 * ACCESS EXCLUSIVE full-table rewrite on a table payroll reads during
 * generation and lock, and `prisma migrate dev` is broken in this repo so there
 * is no shadow-DB rehearsal. The CHECK gives the same integrity; these unions
 * give the same type safety. New tables DO use real Prisma enums — they have no
 * legacy rows and no existing callers, so enums there are free.
 */

export const ADVANCE_LOAN_TYPES = ['ADVANCE', 'LOAN'] as const;
export type AdvanceLoanType = (typeof ADVANCE_LOAN_TYPES)[number];

export const LOAN_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'DISBURSED',
  'ACTIVE',
  // A loan whose instalments are `loan_overdue_after_cycles` behind. Still
  // recovered — being late is not a reason to stop collecting — and cleared
  // automatically once it catches up.
  'OVERDUE',
  'ON_HOLD',
  'CLOSED',
  'WRITTEN_OFF',
  'RECEIVABLE',
  'SETTLED',
  'COMPLETED',
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/**
 * Statuses payroll recovers against.
 *
 * `APPROVED` is retained deliberately: every pre-v2 row sits in it, and keeping
 * it eligible means the v2 rollout needs no data migration. The v2 lifecycle is
 * APPROVED -> DISBURSED -> ACTIVE.
 */
export const LOAN_RECOVERABLE_STATUSES: LoanStatus[] = [
  'APPROVED',
  'DISBURSED',
  'ACTIVE',
  // Deliberately recoverable: a loan being behind is the reason to keep
  // collecting, not to stop. Excluding it would have made the new status
  // quietly forgive the debt it was meant to flag.
  'OVERDUE',
];

/**
 * Statuses where an outstanding BALANCE can exist.
 *
 * Wider than LOAN_RECOVERABLE_STATUSES (which is about payroll eligibility):
 * an ON_HOLD or RECEIVABLE loan is still owed, payroll just is not the one
 * collecting it. Narrower than "everything": a PENDING or REJECTED request has
 * a principal figure but no debt, and summing `amount - amountRepaid` across
 * those reports money as owed that never left the company.
 */
export const LOAN_DEBT_STATUSES: LoanStatus[] = [
  'APPROVED',
  'DISBURSED',
  'ACTIVE',
  'OVERDUE',
  'ON_HOLD',
  'RECEIVABLE',
];

/** No further money moves against a request in one of these. */
export const LOAN_TERMINAL_STATUSES: LoanStatus[] = [
  'REJECTED',
  'CANCELLED',
  'CLOSED',
  'WRITTEN_OFF',
  'SETTLED',
  'COMPLETED',
];

/** Ledger row states. VOID/REVERSED exist so a reversal stays auditable. */
export const LOAN_DEDUCTION_STATUSES = [
  'PENDING',
  'PAID',
  'SKIPPED',
  'REVERSED',
  'VOID',
] as const;
export type LoanDeductionStatus = (typeof LOAN_DEDUCTION_STATUSES)[number];

// ── Recovery planning ───────────────────────────────────────────────────────

export type RecoveryOutcome = 'FULL' | 'PARTIAL' | 'DEFER' | 'SKIP' | 'HOLD';

export type RecoveryReason =
  | 'AFFORDABLE'
  | 'INSUFFICIENT_NET'
  | 'ZERO_NET'
  | 'UNPAID_LEAVE'
  | 'ON_HOLD'
  | 'GRACE_PERIOD'
  | 'RUN_TYPE_EXCLUDED'
  | 'ALREADY_SCHEDULED';

/** What happens when net salary cannot cover the full instalment. */
export type ShortfallPolicy = 'PARTIAL' | 'DEFER' | 'SKIP';

/** Where a deferred instalment goes. */
export type DeferralMode = 'CARRY_FORWARD' | 'EXTEND_TENURE';

/** Per-leave-type loan behaviour, resolved strictest-wins. */
export type LeaveLoanPolicy = 'CONTINUE' | 'PAUSE' | 'EXTEND';

/** Order a single payment is applied in. */
export type PaymentAllocationOrder = 'INTEREST_FIRST' | 'PRINCIPAL_FIRST';
