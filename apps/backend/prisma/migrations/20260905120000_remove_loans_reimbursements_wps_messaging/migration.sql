-- Permanent removal of six product areas: salary advances & loans, the
-- loan-only accounting feed, reimbursements, salary payment files (WPS),
-- external attendance integrations, and the WhatsApp / Telegram / Discord
-- messaging channels.
--
-- Everything here is a DROP. The tables are gone from the Prisma schema and
-- from `src/`, so leaving them behind would only be an unreadable liability:
-- rows nothing writes, foreign keys nothing honours, and a schema that no
-- longer matches the client. Written idempotently (IF EXISTS / CASCADE) so it
-- is safe on a database that never had some of these tables.

-- ============================================================================
-- 1. Columns on SURVIVING tables that pointed at the removed features
-- ============================================================================

-- `employees.attendance_external_id` was written only by the deleted external
-- attendance sync. Its indexes go with it (CASCADE on the column would drop
-- them anyway; naming them keeps the intent readable).
DROP INDEX IF EXISTS "unique_branch_external_attendance_id";
DROP INDEX IF EXISTS "employees_attendance_external_id_idx";
ALTER TABLE "employees" DROP COLUMN IF EXISTS "attendance_external_id";

-- Payroll no longer has a reimbursement or a loan-recovery bucket.
ALTER TABLE "payroll_items" DROP COLUMN IF EXISTS "reimbursement";
ALTER TABLE "payroll_items" DROP COLUMN IF EXISTS "advance_loan_deduction";

-- Travel no longer raises a loan advance.
ALTER TABLE "travel_requests" DROP COLUMN IF EXISTS "advance_loan_id";

-- LEAVE_TYPE library metadata that only governed loan EMIs during unpaid leave.
ALTER TABLE "library_items" DROP COLUMN IF EXISTS "loan_deduction_policy";

-- ============================================================================
-- 2. Payslip line buckets
--
-- `bucket` names the PayrollItem column a line rolls into, so the CHECK must
-- lose exactly the two buckets whose columns were just dropped. Recreated in
-- full rather than patched: a constraint is not editable in place, and the
-- surviving list is what the invariant is stated against.
-- ============================================================================

ALTER TABLE "payroll_item_lines"
  DROP CONSTRAINT IF EXISTS "payroll_item_line_bucket_known";

-- Lines already written into a removed bucket go before the narrower check is
-- re-added, or it could not be added at all on an existing database.
DELETE FROM "payroll_item_lines"
  WHERE "bucket" IN ('reimbursement', 'advanceLoanDeduction');

ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_line_bucket_known"
  CHECK ("bucket" IN (
    'baseSalary', 'allowances', 'bonus', 'overtimePay', 'foodAllowance',
    'leaveEncashment',
    'deduction', 'garnishment', 'otherRecovery',
    'insurance', 'tax'
  ));

-- ============================================================================
-- 3. Tables — dropped child-first, with CASCADE so any remaining foreign key
--    or view from a partially-applied history cannot block the drop.
-- ============================================================================

-- Messaging channels -----------------------------------------------------
DROP TABLE IF EXISTS "telegram_messages" CASCADE;
DROP TABLE IF EXISTS "telegram_identities" CASCADE;

DROP TABLE IF EXISTS "discord_action_tokens" CASCADE;
DROP TABLE IF EXISTS "discord_messages" CASCADE;
DROP TABLE IF EXISTS "discord_identities" CASCADE;

DROP TABLE IF EXISTS "whatsapp_action_tokens" CASCADE;
DROP TABLE IF EXISTS "whatsapp_pending_actions" CASCADE;
DROP TABLE IF EXISTS "whatsapp_inbound_messages" CASCADE;
DROP TABLE IF EXISTS "whatsapp_messages" CASCADE;
DROP TABLE IF EXISTS "whatsapp_sessions" CASCADE;
DROP TABLE IF EXISTS "whatsapp_enrollments" CASCADE;
DROP TABLE IF EXISTS "whatsapp_identities" CASCADE;

-- Salary payment files (WPS) ---------------------------------------------
DROP TABLE IF EXISTS "wps_file_rows" CASCADE;
DROP TABLE IF EXISTS "wps_files" CASCADE;
DROP TABLE IF EXISTS "wps_configurations" CASCADE;
DROP TABLE IF EXISTS "wps_employer_profiles" CASCADE;

-- External attendance providers ------------------------------------------
DROP TABLE IF EXISTS "attendance_sync_runs" CASCADE;
DROP TABLE IF EXISTS "attendance_integrations" CASCADE;

-- Accounting (the loan-only ledger feed) ---------------------------------
DROP TABLE IF EXISTS "journal_lines" CASCADE;
DROP TABLE IF EXISTS "journal_entries" CASCADE;
DROP TABLE IF EXISTS "ledger_mappings" CASCADE;
DROP TABLE IF EXISTS "ledger_accounts" CASCADE;

-- Salary advances & loans -------------------------------------------------
DROP TABLE IF EXISTS "advance_loan_attachments" CASCADE;
DROP TABLE IF EXISTS "advance_loan_notification_logs" CASCADE;
DROP TABLE IF EXISTS "loan_settlements" CASCADE;
DROP TABLE IF EXISTS "loan_rate_changes" CASCADE;
DROP TABLE IF EXISTS "loan_transactions" CASCADE;
DROP TABLE IF EXISTS "advance_loan_deductions" CASCADE;
DROP TABLE IF EXISTS "loan_schedules" CASCADE;
DROP TABLE IF EXISTS "advance_loan_requests" CASCADE;
DROP TABLE IF EXISTS "loan_policies" CASCADE;
DROP TABLE IF EXISTS "loan_types" CASCADE;

-- Reimbursements ----------------------------------------------------------
DROP TABLE IF EXISTS "reimbursement_attachments" CASCADE;
DROP TABLE IF EXISTS "reimbursements" CASCADE;

-- ============================================================================
-- 4. Sequence and enum types the removed tables owned
-- ============================================================================

DROP SEQUENCE IF EXISTS "loan_reference_seq";

DROP TYPE IF EXISTS "LoanGraceMode";
DROP TYPE IF EXISTS "LoanProcessingFeeMode";
DROP TYPE IF EXISTS "LoanClosureType";
DROP TYPE IF EXISTS "LoanTransactionStatus";
DROP TYPE IF EXISTS "LoanTransactionType";
DROP TYPE IF EXISTS "LoanScheduleStatus";
DROP TYPE IF EXISTS "LoanDeductionFrequency";
DROP TYPE IF EXISTS "LoanInterestMethod";

-- ============================================================================
-- 5. ApprovalRequestType loses ADVANCE_LOAN
--
-- Postgres cannot remove a value from an enum, so the type is rebuilt. Any
-- workflow or approval row still routing an advance-loan request is deleted
-- first — the request it approved no longer exists, so an orphaned step could
-- only sit in a queue nobody can clear.
-- ============================================================================

DELETE FROM "request_approvals" WHERE "request_type" = 'ADVANCE_LOAN';
DELETE FROM "approval_workflows" WHERE "request_type" = 'ADVANCE_LOAN';

ALTER TYPE "ApprovalRequestType" RENAME TO "ApprovalRequestType_old";

CREATE TYPE "ApprovalRequestType" AS ENUM (
  'LEAVE', 'OVERTIME', 'BANK_CHANGE', 'TRAVEL', 'TRAINING'
);

ALTER TABLE "approval_workflows"
  ALTER COLUMN "request_type" TYPE "ApprovalRequestType"
  USING ("request_type"::text::"ApprovalRequestType");

ALTER TABLE "request_approvals"
  ALTER COLUMN "request_type" TYPE "ApprovalRequestType"
  USING ("request_type"::text::"ApprovalRequestType");

DROP TYPE "ApprovalRequestType_old";
