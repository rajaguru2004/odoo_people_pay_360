-- ─── WHY ────────────────────────────────────────────────────────────────────
--
-- Top-up (gap report §8). `LoanTransactionType.TOPUP_SETTLEMENT`,
-- `LoanClosureType.TOPPED_UP`, `approvalSource = 'TOPUP'` and the settings
-- `loan_topup_enabled` / `loan_topup_mode` all existed with zero implementing
-- code. The one thing the schema could not express was the LINK: which loan a
-- top-up settled. Without it a topped-up loan is indistinguishable from one
-- that was closed and coincidentally followed by another.
--
-- SET NULL rather than CASCADE, matching `converted_from_id`: losing the
-- predecessor must not delete the loan that replaced it.

ALTER TABLE "advance_loan_requests"
  ADD COLUMN IF NOT EXISTS "topup_of_id" UUID;

DO $$ BEGIN
  ALTER TABLE "advance_loan_requests"
    ADD CONSTRAINT "advance_loan_requests_topup_of_id_fkey"
    FOREIGN KEY ("topup_of_id") REFERENCES "advance_loan_requests"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "advance_loan_requests_topup_of_id_idx"
  ON "advance_loan_requests" ("topup_of_id");
