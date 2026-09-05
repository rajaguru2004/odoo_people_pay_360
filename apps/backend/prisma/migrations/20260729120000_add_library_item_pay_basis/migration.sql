-- Pay basis flag on an EMPLOYMENT_TYPE library item.
--
-- Until now "Employment Type = Daily Wage" (a free-text library label) and
-- "Pay Basis = MONTHLY/DAILY" were two unrelated fields on the employee form.
-- Picking the daily-wage employment type while leaving the pay basis at its
-- MONTHLY default was silently accepted, and the engine then read that
-- employee's PER-DAY rate as a monthly salary.
--
-- With this column the library item itself carries the basis, the server
-- DERIVES employees.salary_type from it, and the UI locks the Pay Basis field.
-- No employment-type label is hardcoded in pay logic — an admin can flag any
-- custom type.
--
-- Deliberately VARCHAR(20), matching employees.salary_type, rather than a
-- Postgres enum: ALTER TYPE ... ADD VALUE cannot run inside a transaction and
-- cannot be used in the same transaction that adds it (see 20260721140000).
-- Deliberately no CHECK constraint either: Prisma does not model check
-- constraints, so one would show as permanent `prisma migrate diff` drift.
-- Validation lives in the DTO (@IsIn) and toSalaryBasis() normalizes on read.

ALTER TABLE "library_items"
  ADD COLUMN IF NOT EXISTS "pay_basis" VARCHAR(20);

-- ── 1. Flag the library items ───────────────────────────────────────────────
-- Match on wording, not an exact constant, so renamed/localized labels convert
-- too. NULLs only, so re-running never stomps an admin's deliberate choice.

UPDATE "library_items"
   SET "pay_basis" = 'DAILY'
 WHERE "library_type" = 'EMPLOYMENT_TYPE'::"LibraryType"
   AND "pay_basis" IS NULL
   AND "label" ILIKE '%daily%';

UPDATE "library_items"
   SET "pay_basis" = 'MONTHLY'
 WHERE "library_type" = 'EMPLOYMENT_TYPE'::"LibraryType"
   AND "pay_basis" IS NULL
   AND "label" ILIKE '%monthly%';

-- ── 2. Audit BEFORE converging ──────────────────────────────────────────────
-- Flipping salary_type re-interprets base_salary (a monthly amount becomes a
-- per-day rate), which is exactly the change employee_history exists to record.
-- Write the audit rows first so the report below can enumerate them.
--
-- employee_history.changed_by is NOT NULL uuid with no FK relation declared, so
-- the oldest ADMIN stands in for "the system". The WHERE EXISTS guard makes the
-- whole statement a no-op on a database with no admin yet (a fresh bootstrap),
-- where there is nothing to converge anyway.

INSERT INTO "employee_history" ("employee_id", "field", "old_value", "new_value", "changed_by")
SELECT e."id",
       'salaryType',
       e."salary_type",
       li."pay_basis",
       (SELECT u."id" FROM "users" u WHERE u."role" = 'ADMIN' ORDER BY u."created_at" LIMIT 1)
  FROM "employees" e
  JOIN "library_items" li
    ON li."library_type" = 'EMPLOYMENT_TYPE'::"LibraryType"
   AND li."label" = e."employment_type"
 WHERE li."pay_basis" IS NOT NULL
   AND e."salary_type" IS DISTINCT FROM li."pay_basis"
   AND EXISTS (SELECT 1 FROM "users" WHERE "role" = 'ADMIN');

-- ── 3. Converge ─────────────────────────────────────────────────────────────
-- The employment type is now the source of truth for pay basis.
-- Run `npm run prisma:report:daily-wage` straight after this to review every
-- employee whose basis moved and confirm their base_salary is a sane day rate.

UPDATE "employees" e
   SET "salary_type" = li."pay_basis"
  FROM "library_items" li
 WHERE li."library_type" = 'EMPLOYMENT_TYPE'::"LibraryType"
   AND li."label" = e."employment_type"
   AND li."pay_basis" IS NOT NULL
   AND e."salary_type" IS DISTINCT FROM li."pay_basis";
