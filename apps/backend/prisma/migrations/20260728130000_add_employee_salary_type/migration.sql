-- Pay basis for an employee: MONTHLY (fixed monthly salary, absence handled by
-- Loss of Pay) or DAILY (daily wage — base_salary is a PER-DAY rate and only
-- days actually worked are paid).
--
-- Before this column existed the payroll engine read every base_salary as a
-- monthly amount, so daily-wage staff (whose base_salary holds a day rate) were
-- paid one day's rate for a whole month and their overtime hourly rate was
-- understated ~work-days-fold.

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "salary_type" VARCHAR(20) NOT NULL DEFAULT 'MONTHLY';

-- Backfill: anything already classified under a daily-wage employment type is a
-- daily-wage worker. employment_type is a free-text EMPLOYMENT_TYPE library
-- label, so match on the wording rather than an exact constant.
UPDATE "employees"
   SET "salary_type" = 'DAILY'
 WHERE "employment_type" ILIKE '%daily%';

-- ── Overtime Policy integrity ───────────────────────────────────────────────
-- The two partial unique indexes the policy engine relies on. They cannot be
-- expressed in the Prisma schema, so `prisma db push` silently omits them and
-- an environment set up that way can end up with two active default policies
-- (or two active policies targeting one employment type), making resolution
-- non-deterministic. Created here idempotently so every environment converges.

CREATE UNIQUE INDEX IF NOT EXISTS "overtime_policies_one_active_default"
  ON "overtime_policies" ("is_default")
  WHERE "is_default" = true AND "is_active" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "overtime_policies_one_active_per_emptype"
  ON "overtime_policies" ("employment_type")
  WHERE "employment_type" IS NOT NULL AND "is_active" = true;
