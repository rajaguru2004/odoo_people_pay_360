-- Loan & Advances v2 — step B of 3: schema.
--
-- Hand-written, matching the repo convention (see 20260803160000_add_hr_budgeting):
-- `prisma migrate dev` is broken here — shadow-DB replay dies on the pre-existing
-- library_items migration — so every statement is idempotent and this file is
-- applied with `prisma db execute` then recorded with `prisma migrate resolve`.
--
-- Depends on 20260806100000 having added 'ADVANCE_LOAN' to ApprovalRequestType.
--
-- Design notes that the schema alone does not carry:
--   * advance_loan_requests.status/.type stay VARCHAR with a CHECK rather than
--     becoming Prisma enums. Converting them is an ACCESS EXCLUSIVE full-table
--     rewrite on a table payroll reads during generation and lock, and with
--     migrate dev broken there is no shadow-DB rehearsal — one shot on a live
--     table. The CHECK gives the same integrity; src/advance-loans/loan.types.ts
--     gives the same type safety.
--   * amount_repaid changes MEANING in v2: principal repaid, not total cash.
--     With interest, cash exceeds principal, and a cash-based counter would
--     auto-complete loans early. This is invisible for every existing row
--     (all zero-interest), but do not "fix" it back.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Enums
-- ══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE "LoanInterestMethod" AS ENUM ('NONE', 'FLAT', 'REDUCING_BALANCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanDeductionFrequency" AS ENUM ('MONTHLY', 'WEEKLY', 'QUARTERLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanScheduleStatus" AS ENUM (
    'SCHEDULED', 'PARTIAL', 'PAID', 'DEFERRED', 'SKIPPED',
    'WAIVED', 'WRITTEN_OFF', 'CLOSED_EARLY', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanTransactionType" AS ENUM (
    'DISBURSEMENT', 'PROCESSING_FEE', 'EMI_RECOVERY', 'PREPAYMENT', 'WAIVER',
    'WRITE_OFF', 'ADJUSTMENT', 'SETTLEMENT', 'CONVERSION', 'TOPUP_SETTLEMENT',
    'REVERSAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanTransactionStatus" AS ENUM ('POSTED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanClosureType" AS ENUM (
    'AUTO', 'MANUAL', 'EARLY_CLOSURE', 'FORECLOSED', 'WRITE_OFF', 'WAIVER',
    'SETTLEMENT', 'CONVERTED', 'TOPPED_UP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanProcessingFeeMode" AS ENUM (
    'DEDUCT_FROM_DISBURSEMENT', 'ADD_TO_FIRST_EMI', 'CAPITALIZE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LoanGraceMode" AS ENUM (
    'NONE', 'MORATORIUM_FULL', 'MORATORIUM_INTEREST_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PayrollRunType" AS ENUM (
    'REGULAR', 'OFF_CYCLE', 'BONUS', 'ADJUSTMENT', 'FINAL_SETTLEMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. loan_types — the product catalogue
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_types" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"                      VARCHAR(40)  NOT NULL,
  "name"                      VARCHAR(120) NOT NULL,
  "category"                  VARCHAR(20)  NOT NULL DEFAULT 'LOAN',
  "is_active"                 BOOLEAN      NOT NULL DEFAULT TRUE,
  "sort_order"                INTEGER      NOT NULL DEFAULT 0,
  "branch_id"                 UUID,
  "interest_method"           "LoanInterestMethod"     NOT NULL DEFAULT 'NONE',
  "interest_rate"             DECIMAL(6,3) NOT NULL DEFAULT 0,
  "deduction_frequency"       "LoanDeductionFrequency" NOT NULL DEFAULT 'MONTHLY',
  "default_installments"      INTEGER      NOT NULL DEFAULT 12,
  "max_installments"          INTEGER      NOT NULL DEFAULT 24,
  "processing_fee_percent"    DECIMAL(6,3) NOT NULL DEFAULT 0,
  "processing_fee_flat"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "processing_fee_mode"       "LoanProcessingFeeMode" NOT NULL DEFAULT 'DEDUCT_FROM_DISBURSEMENT',
  "employer_subsidy_percent"  DECIMAL(5,2) NOT NULL DEFAULT 0,
  "grace_periods"             INTEGER      NOT NULL DEFAULT 0,
  "grace_mode"                "LoanGraceMode" NOT NULL DEFAULT 'NONE',
  "max_amount"                DECIMAL(12,2),
  "max_multiple_of_salary"    DECIMAL(6,2),
  "min_service_months"        INTEGER      NOT NULL DEFAULT 0,
  "max_active_loans"          INTEGER      NOT NULL DEFAULT 1,
  "min_net_salary_after_emi"  DECIMAL(12,2),
  "max_emi_percent_of_net"    DECIMAL(5,2),
  "min_emi_amount"            DECIMAL(12,2),
  "requires_security"         BOOLEAN      NOT NULL DEFAULT FALSE,
  "eligible_positions"        TEXT[]       NOT NULL DEFAULT '{}',
  "eligible_employment_types" TEXT[]       NOT NULL DEFAULT '{}',
  "priority"                  INTEGER      NOT NULL DEFAULT 100,
  "pause_on_unpaid_leave"     BOOLEAN      NOT NULL DEFAULT TRUE,
  "allow_prepayment"          BOOLEAN      NOT NULL DEFAULT TRUE,
  "allow_write_off"           BOOLEAN      NOT NULL DEFAULT TRUE,
  "created_at"                TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "updated_at"                TIMESTAMP(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_types_code_key" ON "loan_types" ("code");
CREATE INDEX IF NOT EXISTS "loan_types_is_active_sort_order_idx" ON "loan_types" ("is_active", "sort_order");
CREATE INDEX IF NOT EXISTS "loan_types_branch_id_idx" ON "loan_types" ("branch_id");

DO $$ BEGIN
  ALTER TABLE "loan_types" ADD CONSTRAINT "loan_types_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. loan_policies — per-branch recovery policy
--
-- SystemSetting is key-unique with no branch column and must not gain one; the
-- established per-branch precedent in this codebase is a dedicated table/column.
-- branch_id NULL is the single global fallback row, so the unique index doubles
-- as "at most one policy per branch, at most one global".
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_policies" (
  "id"                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branch_id"                           UUID,
  "is_active"                           BOOLEAN NOT NULL DEFAULT TRUE,
  "min_net_pay_amount"                  DECIMAL(12,2),
  "min_net_pay_percent"                 DECIMAL(5,2),
  "max_total_deduction_percent_of_net"  DECIMAL(5,2),
  "shortfall_policy"                    VARCHAR(20),
  "deferral_mode"                       VARCHAR(20),
  "unpaid_leave_policy"                 VARCHAR(20),
  "grace_period_cycles"                 INTEGER,
  "max_active_per_employee"             INTEGER,
  "min_service_months"                  INTEGER,
  "max_amount_multiple_of_salary"       DECIMAL(6,2),
  "interest_default_method"             "LoanInterestMethod",
  "rounding_tolerance"                  DECIMAL(12,2),
  "write_off_roles"                     VARCHAR(200),
  "waiver_roles"                        VARCHAR(200),
  "created_at"                          TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "updated_at"                          TIMESTAMP(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_policies_branch_id_key" ON "loan_policies" ("branch_id");

DO $$ BEGIN
  ALTER TABLE "loan_policies" ADD CONSTRAINT "loan_policies_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. advance_loan_requests — additive columns
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE "advance_loan_requests"
  ADD COLUMN IF NOT EXISTS "loan_type_id"             UUID,
  ADD COLUMN IF NOT EXISTS "reference_no"             VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "currency"                 VARCHAR(3)  NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS "employee_code_snapshot"   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "employee_name_snapshot"   VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "interest_method"          "LoanInterestMethod" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "interest_rate"            DECIMAL(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deduction_frequency"      "LoanDeductionFrequency" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN IF NOT EXISTS "processing_fee"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "processing_fee_mode"      "LoanProcessingFeeMode" NOT NULL DEFAULT 'DEDUCT_FROM_DISBURSEMENT',
  ADD COLUMN IF NOT EXISTS "employer_subsidy_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "security_deposit"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grace_periods"            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grace_mode"               "LoanGraceMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "effective_date"           DATE,
  ADD COLUMN IF NOT EXISTS "disbursement_date"        DATE,
  ADD COLUMN IF NOT EXISTS "disbursed_amount"         DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "first_deduction_date"     DATE,
  ADD COLUMN IF NOT EXISTS "priority"                 INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "hold_from"                DATE,
  ADD COLUMN IF NOT EXISTS "hold_until"               DATE,
  ADD COLUMN IF NOT EXISTS "hold_reason"              TEXT,
  ADD COLUMN IF NOT EXISTS "outstanding_principal"    DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "outstanding_interest"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "interest_accrued"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "interest_paid"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fees_paid"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_payable"            DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "written_off_amount"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "waived_amount"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "closure_type"             "LoanClosureType",
  ADD COLUMN IF NOT EXISTS "closed_at"                TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "closure_remarks"          TEXT,
  ADD COLUMN IF NOT EXISTS "schedule_version"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "restructured_at"          TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "restructured_by"          UUID,
  ADD COLUMN IF NOT EXISTS "created_on_behalf_by"     UUID,
  ADD COLUMN IF NOT EXISTS "approval_source"          VARCHAR(20) NOT NULL DEFAULT 'SELF',
  ADD COLUMN IF NOT EXISTS "settlement_mode"          VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "converted_from_id"        UUID,
  ADD COLUMN IF NOT EXISTS "import_batch_id"          UUID,
  ADD COLUMN IF NOT EXISTS "opening_principal"        DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "opening_repaid"           DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "version"                  INTEGER NOT NULL DEFAULT 0;

-- reference_no is intentionally NOT backfilled: it is unique and nullable, and
-- inventing references for legacy rows would just make them collide later. One
-- is minted on the row's first v2 touch.
CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_requests_reference_no_key"
  ON "advance_loan_requests" ("reference_no");
CREATE INDEX IF NOT EXISTS "advance_loan_requests_employee_id_status_idx"
  ON "advance_loan_requests" ("employee_id", "status");
CREATE INDEX IF NOT EXISTS "advance_loan_requests_employee_id_status_priority_idx"
  ON "advance_loan_requests" ("employee_id", "status", "priority");
CREATE INDEX IF NOT EXISTS "advance_loan_requests_loan_type_id_idx"
  ON "advance_loan_requests" ("loan_type_id");

DO $$ BEGIN
  ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_loan_type_id_fkey"
    FOREIGN KEY ("loan_type_id") REFERENCES "loan_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_converted_from_id_fkey"
    FOREIGN KEY ("converted_from_id") REFERENCES "advance_loan_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: currency from the configured payroll currency, effective_date from
-- the creation timestamp, snapshots from the live employee row.
UPDATE "advance_loan_requests" r
   SET "currency" = COALESCE(
         (SELECT s.value FROM "system_settings" s WHERE s.key = 'payroll_currency'),
         'INR')
 WHERE r."currency" = 'INR';

UPDATE "advance_loan_requests"
   SET "effective_date" = "created_at"::date
 WHERE "effective_date" IS NULL;

UPDATE "advance_loan_requests" r
   SET "employee_code_snapshot" = e."employee_code",
       "employee_name_snapshot" = e."full_name"
  FROM "employees" e
 WHERE e."id" = r."employee_id"
   AND r."employee_code_snapshot" IS NULL;

-- Existing rows are all zero-interest, so outstanding principal is exactly the
-- unrecovered amount.
UPDATE "advance_loan_requests"
   SET "outstanding_principal" = GREATEST("amount" - "amount_repaid", 0)
 WHERE "outstanding_principal" IS NULL;

-- Status/type integrity without the cost of a real enum (see header).
DO $$ BEGIN
  ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_status_chk"
    CHECK ("status" IN ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','DISBURSED',
                        'ACTIVE','ON_HOLD','CLOSED','WRITTEN_OFF','RECEIVABLE','SETTLED','COMPLETED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_type_chk"
    CHECK ("type" IN ('ADVANCE','LOAN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Loan history must outlive the employee record for statutory audit. The
-- application also guards employees.service.ts hardDelete() so this surfaces as
-- a readable message rather than a raw P2003.
ALTER TABLE "advance_loan_requests" DROP CONSTRAINT IF EXISTS "advance_loan_requests_employee_id_fkey";
ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. loan_schedules — the plan
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_schedules" (
  "id"                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"                 UUID    NOT NULL,
  "version"                    INTEGER NOT NULL DEFAULT 1,
  "installment_no"             INTEGER NOT NULL,
  "due_date"                   DATE    NOT NULL,
  -- due_year * 12 + due_month. Denormalised so "this cycle OR earlier" — the
  -- rule that sweeps arrears forward — is one indexed integer comparison rather
  -- than an OR-of-tuples or per-row date arithmetic across 100k loans.
  "due_cycle_key"              INTEGER NOT NULL,
  "due_month"                  INTEGER NOT NULL,
  "due_year"                   INTEGER NOT NULL,
  "opening_balance"            DECIMAL(12,2) NOT NULL,
  "principal_component"        DECIMAL(12,2) NOT NULL,
  "interest_component"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "employer_subsidy_component" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "fee_component"              DECIMAL(12,2) NOT NULL DEFAULT 0,
  "emi_amount"                 DECIMAL(12,2) NOT NULL,
  "closing_balance"            DECIMAL(12,2) NOT NULL,
  "status"                     "LoanScheduleStatus" NOT NULL DEFAULT 'SCHEDULED',
  "paid_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paid_principal"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paid_interest"              DECIMAL(12,2) NOT NULL DEFAULT 0,
  "carry_forward_amount"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "settled_at"                 TIMESTAMP(6),
  "superseded_at"              TIMESTAMP(6),
  "note"                       TEXT,
  "created_at"                 TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "updated_at"                 TIMESTAMP(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_schedules_request_id_version_installment_no_key"
  ON "loan_schedules" ("request_id", "version", "installment_no");
CREATE INDEX IF NOT EXISTS "loan_schedules_request_id_status_idx" ON "loan_schedules" ("request_id", "status");
CREATE INDEX IF NOT EXISTS "loan_schedules_due_cycle_key_status_idx" ON "loan_schedules" ("due_cycle_key", "status");
CREATE INDEX IF NOT EXISTS "loan_schedules_due_date_status_idx" ON "loan_schedules" ("due_date", "status");

DO $$ BEGIN
  ALTER TABLE "loan_schedules" ADD CONSTRAINT "loan_schedules_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. advance_loan_deductions — the payroll repayment ledger
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE "advance_loan_deductions"
  ADD COLUMN IF NOT EXISTS "schedule_id"         UUID,
  ADD COLUMN IF NOT EXISTS "principal_component" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "interest_component"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fee_component"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "planned_amount"      DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "shortfall_amount"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "outcome"             VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "reason"              VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "is_manual"           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "reversed_at"         TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "reversed_by"         UUID;

-- Every pre-v2 deduction was pure principal — there was no interest engine —
-- so this backfill is exact, and it has to run BEFORE the split CHECK below.
UPDATE "advance_loan_deductions"
   SET "principal_component" = "amount"
 WHERE "principal_component" = 0 AND "amount" <> 0;

DO $$ BEGIN
  ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "loan_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- payroll_item_id flips Cascade -> SetNull: after an unlock the payroll holds
-- REVERSED rows whose history must survive the run being deleted.
-- payrolls.remove() compensates by explicitly deleting the PENDING rows, so the
-- "delete a draft payroll re-releases the installment" behaviour is unchanged.
ALTER TABLE "advance_loan_deductions" DROP CONSTRAINT IF EXISTS "advance_loan_deductions_payroll_item_id_fkey";
ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_payroll_item_id_fkey"
  FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$ BEGIN
  ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_status_chk"
    CHECK ("status" IN ('PENDING','PAID','SKIPPED','REVERSED','VOID'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Makes an engine rounding bug fail LOUDLY at write time instead of silently
-- drifting amount_repaid.
DO $$ BEGIN
  ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_split_chk"
    CHECK ("principal_component" + "interest_component" + "fee_component" = "amount");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- THE double-EMI guard. One LIVE recovery row per planned installment, enforced
-- by the database rather than by an application read-then-write that two
-- concurrent payroll runs will interleave. SKIPPED/REVERSED/VOID sit outside
-- the predicate so an explanatory zero row never blocks a genuine later
-- recovery.
CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_deductions_schedule_live_uq"
  ON "advance_loan_deductions" ("schedule_id")
  WHERE "schedule_id" IS NOT NULL AND "status" IN ('PENDING','PAID');

-- Same guard for legacy / schedule-less advance recovery: one per cycle.
CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_deductions_request_period_uq"
  ON "advance_loan_deductions" ("request_id", "year", "month")
  WHERE "schedule_id" IS NULL AND "status" IN ('PENDING','PAID');

CREATE INDEX IF NOT EXISTS "advance_loan_deductions_request_id_status_idx"
  ON "advance_loan_deductions" ("request_id", "status");
CREATE INDEX IF NOT EXISTS "advance_loan_deductions_schedule_id_status_idx"
  ON "advance_loan_deductions" ("schedule_id", "status");
CREATE INDEX IF NOT EXISTS "advance_loan_deductions_year_month_status_idx"
  ON "advance_loan_deductions" ("year", "month", "status");
CREATE INDEX IF NOT EXISTS "advance_loan_deductions_payroll_item_id_status_idx"
  ON "advance_loan_deductions" ("payroll_item_id", "status");

-- ══════════════════════════════════════════════════════════════════════════
-- 7. loan_transactions — every non-payroll money event
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_transactions" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"          UUID NOT NULL,
  "type"                "LoanTransactionType" NOT NULL,
  "status"              "LoanTransactionStatus" NOT NULL DEFAULT 'POSTED',
  "transaction_date"    DATE NOT NULL,
  -- Always POSITIVE; direction is implied by `type`.
  "amount"              DECIMAL(12,2) NOT NULL,
  "principal_component" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "interest_component"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "fee_component"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "balance_after"       DECIMAL(12,2),
  "reference"           VARCHAR(120),
  "narration"           TEXT,
  "source_type"         VARCHAR(30),
  "source_id"           UUID,
  "journal_ref"         VARCHAR(60),
  "idempotency_key"     VARCHAR(120),
  "reversal_of_id"      UUID,
  "deduction_id"        UUID,
  "created_by_id"       UUID,
  "created_at"          TIMESTAMP(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loan_transactions_idempotency_key_key"
  ON "loan_transactions" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "loan_transactions_deduction_id_key"
  ON "loan_transactions" ("deduction_id");
CREATE INDEX IF NOT EXISTS "loan_transactions_request_id_transaction_date_idx"
  ON "loan_transactions" ("request_id", "transaction_date");
CREATE INDEX IF NOT EXISTS "loan_transactions_type_status_idx" ON "loan_transactions" ("type", "status");
CREATE INDEX IF NOT EXISTS "loan_transactions_journal_ref_idx" ON "loan_transactions" ("journal_ref");

DO $$ BEGIN
  ALTER TABLE "loan_transactions" ADD CONSTRAINT "loan_transactions_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "loan_transactions" ADD CONSTRAINT "loan_transactions_reversal_of_id_fkey"
    FOREIGN KEY ("reversal_of_id") REFERENCES "loan_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "loan_transactions" ADD CONSTRAINT "loan_transactions_deduction_id_fkey"
    FOREIGN KEY ("deduction_id") REFERENCES "advance_loan_deductions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 8. loan_rate_changes
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_rate_changes" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"              UUID NOT NULL,
  "effective_from"          DATE NOT NULL,
  "old_rate"                DECIMAL(6,3) NOT NULL,
  "new_rate"                DECIMAL(6,3) NOT NULL,
  "old_method"              "LoanInterestMethod" NOT NULL,
  "new_method"              "LoanInterestMethod" NOT NULL,
  "mode"                    VARCHAR(20) NOT NULL DEFAULT 'KEEP_TENURE',
  "reason"                  TEXT,
  "schedule_version_before" INTEGER NOT NULL,
  "schedule_version_after"  INTEGER NOT NULL,
  "applied_at"              TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "applied_by_id"           UUID
);

CREATE INDEX IF NOT EXISTS "loan_rate_changes_request_id_effective_from_idx"
  ON "loan_rate_changes" ("request_id", "effective_from");

DO $$ BEGIN
  ALTER TABLE "loan_rate_changes" ADD CONSTRAINT "loan_rate_changes_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. loan_settlements
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "loan_settlements" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_id"       UUID NOT NULL,
  "total_outstanding" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "recovered"         DECIMAL(12,2) NOT NULL DEFAULT 0,
  "waived"            DECIMAL(12,2) NOT NULL DEFAULT 0,
  "written_off"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "carried"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- Pre-state snapshot per loan so reverseSettlement() restores exactly.
  "decisions_json"    JSONB NOT NULL,
  "decided_by"        UUID,
  "decided_at"        TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "reversed_at"       TIMESTAMP(6),
  "reversed_by"       UUID,
  "reversal_reason"   TEXT
);

CREATE INDEX IF NOT EXISTS "loan_settlements_employee_id_idx" ON "loan_settlements" ("employee_id");

DO $$ BEGIN
  ALTER TABLE "loan_settlements" ADD CONSTRAINT "loan_settlements_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 10. advance_loan_notification_logs — the dedupe claim table
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "advance_loan_notification_logs" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id"        UUID NOT NULL,
  "event"             VARCHAR(40) NOT NULL,
  "period_key"        VARCHAR(40) NOT NULL DEFAULT '',
  "recipient_user_id" UUID,
  "channel"           VARCHAR(10) NOT NULL DEFAULT 'IN_APP',
  "status"            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "last_error"        TEXT,
  "sent_at"           TIMESTAMP(6),
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT NOW()
);

-- Name must match what Prisma derives for the @@unique, or `migrate diff`
-- reports permanent drift.
CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_notification_logs_request_id_event_period_key__key"
  ON "advance_loan_notification_logs" ("request_id", "event", "period_key", "recipient_user_id", "channel");
CREATE INDEX IF NOT EXISTS "advance_loan_notification_logs_status_attempts_idx"
  ON "advance_loan_notification_logs" ("status", "attempts");

DO $$ BEGIN
  ALTER TABLE "advance_loan_notification_logs" ADD CONSTRAINT "advance_loan_notification_logs_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 11. payroll-side columns
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE "payrolls"
  ADD COLUMN IF NOT EXISTS "run_type"      "PayrollRunType" NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN IF NOT EXISTS "unlocked_at"   TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "unlocked_by"   UUID,
  ADD COLUMN IF NOT EXISTS "unlock_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "unlock_count"  INTEGER NOT NULL DEFAULT 0;

-- Court-ordered attachment of earnings. Subtracted from the pool BEFORE any
-- loan recovery so the statutory > garnishment > protected-net > advance > loan
-- ladder is enforced structurally.
ALTER TABLE "payroll_items"
  ADD COLUMN IF NOT EXISTS "garnishment" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Per-leave-type loan behaviour: 'CONTINUE' | 'PAUSE' | 'EXTEND' | NULL.
-- Follows the established LibraryItem wide-column pattern (is_paid, pay_basis,
-- per_diem_rate) so maternity / sabbatical / suspension / long-medical each get
-- their own rule with no new code.
ALTER TABLE "library_items"
  ADD COLUMN IF NOT EXISTS "loan_deduction_policy" VARCHAR(20);

COMMIT;
