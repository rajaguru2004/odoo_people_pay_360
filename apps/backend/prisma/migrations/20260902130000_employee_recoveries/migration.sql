-- Employer recoveries through payroll.
--
-- `clearance.service.ts` and `GET /assets/clearance/:employeeId` already block an
-- exit while an asset is out or a loan is unrecovered — but that is a GATE, not
-- a RECOVERY: no money moves, and recovering today means raising a loan or a
-- salary component by hand with nothing linking it back to the asset.
--
-- One table with a `kind` rather than one per case, because asset damage, an
-- asset never returned, a training bond and a notice shortfall are mechanically
-- identical and differ only in what a payslip calls them.

CREATE TABLE "employee_recoveries" (
  "id"                  UUID          NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"         UUID          NOT NULL,
  "branch_id"           UUID          NOT NULL,
  "kind"                VARCHAR(30)   NOT NULL,
  "asset_assignment_id" UUID,
  "reference"           VARCHAR(100),
  "total_amount"        DECIMAL(12,2) NOT NULL,
  "amount_recovered"    DECIMAL(12,2) NOT NULL DEFAULT 0,
  "instalment_amount"   DECIMAL(12,2),
  "start_date"          DATE          NOT NULL,
  "end_date"            DATE,
  "priority"            INTEGER       NOT NULL DEFAULT 200,
  "status"              VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
  "reason"              TEXT,
  "created_by"          UUID,
  "waived_by"           UUID,
  "waived_at"           TIMESTAMP(6),
  "waived_reason"       TEXT,
  "created_at"          TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "employee_recoveries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "employee_recoveries_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "employee_recoveries_employee_status_idx"
  ON "employee_recoveries"("employee_id", "status");
CREATE INDEX "employee_recoveries_branch_status_idx"
  ON "employee_recoveries"("branch_id", "status");

-- The payslip label and every report grouping are chosen by kind.
ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_kind_known"
  CHECK ("kind" IN ('ASSET_DAMAGE', 'ASSET_LOSS', 'TRAINING_BOND', 'NOTICE_SHORTFALL', 'OTHER'));

ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_status_known"
  CHECK ("status" IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'RECEIVABLE', 'WAIVED'));

ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_total_positive"
  CHECK ("total_amount" > 0);

-- Mirrors `garnishment_recovery_within_total`: a rounding bug in the allocator
-- fails loudly here rather than over-collecting from someone's wages.
ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_within_total"
  CHECK ("amount_recovered" >= 0 AND "amount_recovered" <= "total_amount");

ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_dates_ordered"
  CHECK ("end_date" IS NULL OR "end_date" >= "start_date");

ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_instalment_positive"
  CHECK ("instalment_amount" IS NULL OR "instalment_amount" > 0);

-- A training bond pointing at a laptop is a data error the asset-loss report
-- cannot recover from, because it would double-count that asset's cost.
ALTER TABLE "employee_recoveries"
  ADD CONSTRAINT "recovery_asset_link_only_for_asset_kinds"
  CHECK ("asset_assignment_id" IS NULL
         OR "kind" IN ('ASSET_DAMAGE', 'ASSET_LOSS'));

-- ── The payslip column ─────────────────────────────────────────────────────
--
-- Post-tax, so it needs its own column. `deduction` sits INSIDE gross, so
-- folding a recovery there would reduce the employee's taxable income — the
-- employer's claim is not a tax relief. `advance_loan_deduction` and
-- `garnishment` would each mislabel it on the payslip and in every report.
ALTER TABLE "payroll_items"
  ADD COLUMN "other_recovery" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Widen the carry-forward ledger to carry a shortfall from a recovery.
--
-- The ONLY existing database object this whole phase modifies. Widening a CHECK
-- cannot invalidate an existing row, changes no column's meaning and no read;
-- Postgres has no ALTER CONSTRAINT for a CHECK, so it must be DROP + ADD, which
-- takes an ACCESS EXCLUSIVE lock for a millisecond-scale validation scan.
ALTER TABLE "payroll_carry_forwards"
  DROP CONSTRAINT IF EXISTS "carry_forward_kind_known";
ALTER TABLE "payroll_carry_forwards"
  ADD CONSTRAINT "carry_forward_kind_known"
  CHECK ("kind" IN ('GARNISHMENT', 'DEDUCTION', 'RECOVERY'));
