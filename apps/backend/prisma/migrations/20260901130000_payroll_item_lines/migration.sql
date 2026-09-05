-- Payslip itemisation.
--
-- `payroll_items` is a fixed-column model: every allowance an employee has
-- collapses into `allowances`, every ad-hoc deduction into `deduction`, PF and
-- ESI both into `insurance`, income tax and professional tax both into `tax`.
-- A payslip therefore cannot tell an employee what any of those figures are
-- made of; today the breakdown survives only inside the free-text `notes`.
--
-- This table is additive and explanatory. The columns on `payroll_items` remain
-- the authoritative money — nothing here is ever summed to pay anyone — so with
-- the `payroll_item_lines_enabled` setting off, no row is written and payroll
-- behaves exactly as it did before this migration.

CREATE TABLE "payroll_item_lines" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "payroll_item_id" UUID         NOT NULL,
  "code"            VARCHAR(50)  NOT NULL,
  "label"           VARCHAR(150) NOT NULL,
  "category"        VARCHAR(20)  NOT NULL,
  "bucket"          VARCHAR(30)  NOT NULL,
  "amount"          DECIMAL(12,2) NOT NULL,
  "source_type"     VARCHAR(30),
  "source_id"       UUID,
  "display_order"   INTEGER      NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payroll_item_lines_pkey" PRIMARY KEY ("id")
);

-- A line belongs to exactly one payslip and dies with it. Regenerating a run
-- deletes its items, and a breakdown of a payslip that no longer exists is
-- nothing but a way to double-count later.
ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_lines_payroll_item_id_fkey"
  FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "payroll_item_lines_item_order_idx"
  ON "payroll_item_lines"("payroll_item_id", "display_order");

-- The sign lives in `category`, never in the number. A negative EARNING and a
-- positive DEDUCTION are the same thing written two ways, and reconciliation
-- cannot tell them apart — so one convention is enforced rather than assumed.
ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_line_amount_non_negative"
  CHECK ("amount" >= 0);

ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_line_category_known"
  CHECK ("category" IN ('EARNING', 'DEDUCTION'));

-- `bucket` is what the reconciliation invariant groups by, so a typo'd value is
-- worse than a rejected one: it would reconcile against nothing, the per-bucket
-- sums would still balance, and the payslip would claim a figure it never paid.
ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_line_bucket_known"
  CHECK ("bucket" IN (
    'baseSalary', 'allowances', 'bonus', 'overtimePay', 'foodAllowance',
    'reimbursement', 'leaveEncashment',
    'deduction', 'advanceLoanDeduction', 'garnishment', 'otherRecovery',
    'insurance', 'tax'
  ));

-- The code is the stable key the UI and every report join on.
ALTER TABLE "payroll_item_lines"
  ADD CONSTRAINT "payroll_item_line_code_not_blank"
  CHECK (length(btrim("code")) > 0);

-- Deliberately absent: a database-level check that the lines sum to the column.
-- It is a cross-row aggregate against a different table, so it needs a
-- CONSTRAINT TRIGGER firing per row on a thousand-employee run — and it would
-- have to special-case "no lines means no assertion" to survive the feature
-- being switched off. A rule that is only conditionally true is one nobody can
-- rely on. The invariant is enforced in `payroll-item-lines.util.ts`, at the two
-- points that write lines, and re-checkable on demand.
