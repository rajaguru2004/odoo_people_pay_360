-- Supervisor review & edit at overtime approval.
--
-- An approver could previously only say yes or no to the hours as filed. Two
-- things were missing: correcting a wrong from/to entry without bouncing the
-- request back to the employee, and granting a site allowance to an individual
-- worker when the site activity warrants it.
--
-- Why each column, rather than reusing what exists:
--
--   site_allowance          Approver-granted and NOT derivable from any policy,
--                           so it cannot live in the food-allowance column that
--                           finalizeOvertimeApproval() recomputes and overwrites
--                           on every approval. It is deliberately absent from
--                           that update payload, which is what keeps it alive.
--
--   food_allowance_override NULLABLE on purpose. The food allowance is computed
--                           by the Overtime Policy, so "the approver did not
--                           touch it" and "the approver set it to 0" are
--                           different facts. A NOT NULL DEFAULT 0 column cannot
--                           tell them apart and would silently zero every
--                           allowance the policy grants. NULL = policy computes;
--                           any value, 0 included, wins. Same "explicit value
--                           wins, otherwise recompute" shape payrolls.service.ts
--                           already uses for the HR payroll-item override.
--
--   original_start_time     Snapshot taken on the FIRST edit only, so the record
--   original_end_time       still shows what the employee actually filed after a
--                           later approver edits it again. Second and subsequent
--                           edits leave them alone.
--
--   edited_by_id / edited_at / approver_note
--                           Who changed the numbers, when, and why. The full
--                           before/after pair is also written to audit_logs as
--                           OVERTIME_APPROVER_EDIT; these columns exist so the
--                           request itself can be rendered without a join.
--
-- Edits are persisted BEFORE approval_engine.decide() runs, because an
-- intermediate approver in a multi-step chain returns early and never reaches
-- finalizeOvertimeApproval() — deferring the write there would silently lose
-- every Step 1 SUPERVISOR edit.
ALTER TABLE "overtime_requests"
  ADD COLUMN IF NOT EXISTS "site_allowance"          DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "site_allowance_note"     TEXT,
  ADD COLUMN IF NOT EXISTS "food_allowance_override" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "approver_note"           TEXT,
  ADD COLUMN IF NOT EXISTS "edited_by_id"            UUID,
  ADD COLUMN IF NOT EXISTS "edited_at"               TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "original_start_time"     TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "original_end_time"       TIMESTAMP(6);

-- SET NULL, not CASCADE: deleting the user who made an edit must not delete the
-- overtime request that edit was made on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'overtime_requests_edited_by_id_fkey'
  ) THEN
    ALTER TABLE "overtime_requests"
      ADD CONSTRAINT "overtime_requests_edited_by_id_fkey"
      FOREIGN KEY ("edited_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "overtime_requests_edited_by_id_idx"
  ON "overtime_requests"("edited_by_id");

-- Its own payroll bucket rather than folded into `food_allowance`, for the same
-- reason `leave_encashment` and `other_recovery` have theirs: the payslip has to
-- name what it is paying for. It is an EARNING, taxable, and reaches the WPS
-- file through the allowances sum in wps-payload.builder.ts — a new column that
-- is not added to that one sum is silently dropped from every wage file.
ALTER TABLE "payroll_items"
  ADD COLUMN IF NOT EXISTS "site_allowance" DECIMAL(12,2) NOT NULL DEFAULT 0;
