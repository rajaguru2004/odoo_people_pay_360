-- ─── WHY ────────────────────────────────────────────────────────────────────
--
-- Two gaps from docs/LOAN-ADVANCES-GAP-REPORT.md, both of the same kind: a
-- concept the product describes and cannot record.
--
--   §9  Garnishment. `payroll_items.garnishment` and the recovery allocator's
--       `CycleContext.garnishment` both existed and payroll passed a hard-coded
--       0, because there was nowhere to say that a court order exists. Without
--       it the documented priority ladder — statutory > garnishment >
--       protected net > advance > loan — was missing its second rung.
--
--   §13 Overdue. `loan_overdue_after_cycles` was seeded and read by nothing,
--       and `OVERDUE` was not an allowed status, so a delinquent loan looked
--       exactly like a healthy one outside the ageing report.
--
-- ─── ORDER ──────────────────────────────────────────────────────────────────
-- The table first, then the CHECK constraint swap. The constraint is replaced
-- rather than edited (Postgres has no ALTER CONSTRAINT for a CHECK), and the
-- drop is IF EXISTS so this is safe on a database provisioned by `db push`,
-- which never created the named constraint in the first place.

-- ── §9 Garnishment orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "garnishment_orders" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"    UUID NOT NULL,
  "reference"      VARCHAR(120) NOT NULL,
  "authority"      VARCHAR(200),
  -- Exactly one of amount / percent_of_net carries the instruction; the
  -- service refuses a row that sets both or neither.
  "amount"         DECIMAL(12,2),
  "percent_of_net" DECIMAL(5,2),
  "total_cap"      DECIMAL(12,2),
  "collected"      DECIMAL(12,2) NOT NULL DEFAULT 0,
  "start_date"     DATE NOT NULL,
  "end_date"       DATE,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "notes"          TEXT,
  "created_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "garnishment_orders_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "garnishment_orders"
    ADD CONSTRAINT "garnishment_orders_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
    -- RESTRICT, like advance_loan_requests: a court order is a legal record and
    -- must not vanish with the employee row.
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "garnishment_orders_employee_id_is_active_idx"
  ON "garnishment_orders" ("employee_id", "is_active");
CREATE INDEX IF NOT EXISTS "garnishment_orders_is_active_start_date_idx"
  ON "garnishment_orders" ("is_active", "start_date");

-- ── §13 OVERDUE becomes a real status ───────────────────────────────────────
ALTER TABLE "advance_loan_requests"
  DROP CONSTRAINT IF EXISTS "advance_loan_requests_status_chk";

ALTER TABLE "advance_loan_requests"
  ADD CONSTRAINT "advance_loan_requests_status_chk"
  CHECK ("status" IN ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','DISBURSED',
                      'ACTIVE','OVERDUE','ON_HOLD','CLOSED','WRITTEN_OFF','RECEIVABLE',
                      'SETTLED','COMPLETED'));
