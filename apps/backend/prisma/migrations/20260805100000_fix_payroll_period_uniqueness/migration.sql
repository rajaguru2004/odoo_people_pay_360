-- Payroll period uniqueness
--
-- The previous constraint was UNIQUE(month, year, batch_id). Postgres treats
-- NULLs as distinct, and every per-branch run created without a batch has
-- batch_id = NULL — which is the common case — so the constraint permitted
-- unlimited duplicate runs for the same period. Duplicate detection was left to
-- a findFirst pre-check in PayrollsService.create(), with a TOCTOU gap before
-- the insert: two HR users creating 8/2026 in the same second both succeed.
-- Two LOCKED payrolls for one month means a wage file can be generated from
-- either, or from both, and the branch is paid twice.
--
-- It was also wrong on two further counts:
--   * no notion of branch — two branches could not each run 8/2026;
--   * no notion of version — createRevision() only avoided a collision by
--     dropping batch_id (and branch_id) from the copy, which orphaned every
--     revision company-wide. Now that a revision correctly inherits both, the
--     constraint must include `version` or every batched revision would fail.
--
-- COALESCE to a sentinel UUID makes NULLs comparable, so the constraint binds
-- for the NULL cases instead of silently permitting everything.

DROP INDEX IF EXISTS "payrolls_month_year_batch_id_key";
ALTER TABLE "payrolls" DROP CONSTRAINT IF EXISTS "payrolls_month_year_batch_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_period_branch_batch_version"
  ON "payrolls" (
    "month",
    "year",
    COALESCE("branch_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("batch_id",  '00000000-0000-0000-0000-000000000000'::uuid),
    "version"
  );
