-- ─── WHY ────────────────────────────────────────────────────────────────────
--
-- `garnishment_orders.collected` alone is a running total and nothing else: it
-- cannot say which cycle took what, cannot be reconciled against a payslip, and
-- cannot be undone when a locked payroll is unlocked. A `total_cap` resting on
-- it would therefore stop collecting at a figure nobody can audit.
--
-- This is the same shape `advance_loan_deductions` already has for loans. The
-- counter stays as the fast read; this table is the truth behind it.
--
-- The unique (order_id, month, year) is what makes an unlock-and-relock safe:
-- the second attempt to record the same cycle loses on the index rather than
-- double-counting.

CREATE TABLE IF NOT EXISTS "garnishment_deductions" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id"        UUID NOT NULL,
  "payroll_item_id" UUID,
  "amount"          DECIMAL(12,2) NOT NULL,
  "month"           INTEGER NOT NULL,
  "year"            INTEGER NOT NULL,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "garnishment_deductions_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "garnishment_deductions"
    ADD CONSTRAINT "garnishment_deductions_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "garnishment_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "garnishment_deductions_order_id_month_year_key"
  ON "garnishment_deductions" ("order_id", "month", "year");

CREATE INDEX IF NOT EXISTS "garnishment_deductions_payroll_item_id_idx"
  ON "garnishment_deductions" ("payroll_item_id");
