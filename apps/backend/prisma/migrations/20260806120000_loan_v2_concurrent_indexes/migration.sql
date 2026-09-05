-- Loan & Advances v2 — step C of 3: hot-path indexes.
--
-- Separate file because CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and step B is wrapped in BEGIN/COMMIT. Apply this one with
-- `prisma db execute` on its own.
--
-- These are the indexes that make the payroll pre-load viable at 100k loans.
-- Without the partial index below, the `deductions: { none: { status:
-- 'PENDING' } }` guard compiles to a correlated NOT EXISTS that scans the
-- ledger once per loan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_ald_pending"
  ON "advance_loan_deductions" ("request_id")
  WHERE "status" = 'PENDING';

-- Drives the per-cycle schedule pick: "everything due this cycle or earlier
-- that is still collectable".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_loan_schedules_collectable"
  ON "loan_schedules" ("due_cycle_key", "request_id")
  WHERE "status" IN ('SCHEDULED', 'PARTIAL', 'DEFERRED');

-- Drives the overdue-ageing report.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_loan_schedules_overdue"
  ON "loan_schedules" ("due_date")
  WHERE "status" IN ('SCHEDULED', 'PARTIAL', 'DEFERRED');
