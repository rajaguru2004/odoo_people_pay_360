-- Remove the Finance module and the payroll extensions.
--
-- DESTRUCTIVE. Payroll keeps run/batch/approval/salary-structure only; every
-- table below belonged to a module that no longer has code behind it, so
-- leaving them would leave rows nothing can read, write or explain.
--
-- Order matters: children before parents, and the two tables that hold a
-- RESTRICT reference to `payrolls` (`wps_files`) go before anything that would
-- make dropping them a cascade decision.

-- ── Wage files ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "wps_file_rows" CASCADE;
DROP TABLE IF EXISTS "wps_files" CASCADE;
DROP TABLE IF EXISTS "wps_configurations" CASCADE;
DROP TABLE IF EXISTS "wps_employer_profiles" CASCADE;

-- ── Accounting ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "journal_lines" CASCADE;
DROP TABLE IF EXISTS "journal_entries" CASCADE;
DROP TABLE IF EXISTS "ledger_mappings" CASCADE;
DROP TABLE IF EXISTS "ledger_accounts" CASCADE;

-- ── Advances & loans ────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "advance_loan_deductions" CASCADE;
DROP TABLE IF EXISTS "advance_loan_attachments" CASCADE;
DROP TABLE IF EXISTS "advance_loan_notification_logs" CASCADE;
DROP TABLE IF EXISTS "loan_transactions" CASCADE;
DROP TABLE IF EXISTS "loan_rate_changes" CASCADE;
DROP TABLE IF EXISTS "loan_settlements" CASCADE;
DROP TABLE IF EXISTS "loan_schedules" CASCADE;
DROP TABLE IF EXISTS "advance_loan_requests" CASCADE;
DROP TABLE IF EXISTS "loan_types" CASCADE;
DROP TABLE IF EXISTS "loan_policies" CASCADE;

-- ── Garnishments ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "garnishment_deductions" CASCADE;
DROP TABLE IF EXISTS "garnishment_orders" CASCADE;

-- ── Reimbursements & travel ─────────────────────────────────────────────────
DROP TABLE IF EXISTS "reimbursement_attachments" CASCADE;
DROP TABLE IF EXISTS "reimbursements" CASCADE;
DROP TABLE IF EXISTS "travel_itineraries" CASCADE;
DROP TABLE IF EXISTS "travel_requests" CASCADE;

-- ── Budgets ─────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "budget_commitments" CASCADE;
DROP TABLE IF EXISTS "budget_lines" CASCADE;
DROP TABLE IF EXISTS "budgets" CASCADE;

-- ── Banking ─────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "bank_change_requests" CASCADE;
DROP TABLE IF EXISTS "employee_bank_details" CASCADE;
DROP TABLE IF EXISTS "country_banking_fields" CASCADE;
DROP TABLE IF EXISTS "banks" CASCADE;

-- ── End-of-service ──────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "final_settlement_lines" CASCADE;
DROP TABLE IF EXISTS "final_settlements" CASCADE;
DROP TABLE IF EXISTS "gratuity_accruals" CASCADE;
DROP TABLE IF EXISTS "gratuity_rules" CASCADE;

-- ── Other payroll extensions ────────────────────────────────────────────────
DROP TABLE IF EXISTS "leave_encashment_requests" CASCADE;
DROP TABLE IF EXISTS "employee_recoveries" CASCADE;
DROP TABLE IF EXISTS "employee_transfers" CASCADE;
DROP TABLE IF EXISTS "payroll_calendar_periods" CASCADE;
DROP TABLE IF EXISTS "payroll_calendars" CASCADE;
DROP TABLE IF EXISTS "grade_salary_components" CASCADE;
DROP TABLE IF EXISTS "grades" CASCADE;

-- ── Columns the dropped modules owned ───────────────────────────────────────
--
-- The payslip columns go with them. Each was money the run computed from a
-- module that is gone, so a surviving column could only ever read 0 while
-- looking like a figure somebody might still owe.
ALTER TABLE "payroll_items"
  DROP COLUMN IF EXISTS "reimbursement",
  DROP COLUMN IF EXISTS "advance_loan_deduction",
  DROP COLUMN IF EXISTS "garnishment",
  DROP COLUMN IF EXISTS "leave_encashment",
  DROP COLUMN IF EXISTS "other_recovery",
  DROP COLUMN IF EXISTS "gratuity_payout";

ALTER TABLE "employees" DROP COLUMN IF EXISTS "grade_id";
ALTER TABLE "branches" DROP COLUMN IF EXISTS "banking_countries";
ALTER TABLE "library_items" DROP COLUMN IF EXISTS "loan_deduction_policy";

-- ── Approval kinds ──────────────────────────────────────────────────────────
--
-- Rows first: an enum value cannot be dropped while anything references it, and
-- these trails belong to requests whose tables are gone above.
DELETE FROM "request_approvals"
  WHERE "request_type" IN ('BANK_CHANGE', 'TRAVEL', 'ADVANCE_LOAN');
DELETE FROM "approval_workflows"
  WHERE "request_type" IN ('BANK_CHANGE', 'TRAVEL', 'ADVANCE_LOAN');

-- Postgres cannot drop a value from an enum in place, so the type is rebuilt.
ALTER TYPE "ApprovalRequestType" RENAME TO "ApprovalRequestType_old";
CREATE TYPE "ApprovalRequestType" AS ENUM ('LEAVE', 'OVERTIME', 'TRAINING');
ALTER TABLE "request_approvals"
  ALTER COLUMN "request_type" TYPE "ApprovalRequestType"
  USING ("request_type"::text::"ApprovalRequestType");
ALTER TABLE "approval_workflows"
  ALTER COLUMN "request_type" TYPE "ApprovalRequestType"
  USING ("request_type"::text::"ApprovalRequestType");
DROP TYPE "ApprovalRequestType_old";

-- ── Loan enums ──────────────────────────────────────────────────────────────
DROP TYPE IF EXISTS "LoanInterestMethod";
DROP TYPE IF EXISTS "LoanDeductionFrequency";
DROP TYPE IF EXISTS "LoanScheduleStatus";
DROP TYPE IF EXISTS "LoanTransactionType";
DROP TYPE IF EXISTS "LoanTransactionStatus";
DROP TYPE IF EXISTS "LoanClosureType";
DROP TYPE IF EXISTS "LoanProcessingFeeMode";
DROP TYPE IF EXISTS "LoanGraceMode";

-- ── Settings rows for features that no longer exist ─────────────────────────
DELETE FROM "system_settings" WHERE "key" IN (
  'reimbursement_enabled', 'reimbursement_approver_roles', 'reimbursement_types',
  'travel_enabled', 'travel_approver_roles',
  'advance_max_percent_of_salary', 'clearance_blocking_enabled',
  'loan_clearance_blocking_enabled', 'loan_interest_enabled',
  'payroll_eosb_enabled', 'payroll_eosb_accrual_enabled',
  'payroll_eosb_settlement_enabled', 'payroll_eosb_pay_through_final_run',
  'payroll_eosb_unknown_nationality_policy', 'payroll_eosb_service_year_days',
  'leave_encashment_enabled', 'leave_encashment_taxable',
  'payroll_calendar_enabled', 'payroll_cutoff_enforcement',
  'payroll_preflight_enabled',
  'payroll_employee_recovery_enabled', 'payroll_recovery_ladder_position',
  'payroll_recovery_respects_min_net',
  'employee_transfer_enabled', 'payroll_transfer_pay_basis',
  'employee_grade_enabled', 'payroll_reports_enabled',
  'payroll_gratuity_enabled', 'payroll_gratuity_rate', 'payroll_label_gratuity'
) OR "key" LIKE 'advance\_loan\_%' OR "key" LIKE 'wps\_%';
