-- HR budgeting with a commitment ledger.
--
--   Remaining = Planned − (OPEN commitments) − Actual
--
-- The commitment is the point: an approved travel or training request consumes
-- budget before the money is spent, so Remaining is honest rather than lagging.
--
-- A commitment goes OPEN -> REALIZED (not RELEASED) when its spend appears in
-- actuals. That single transition is the double-counting guard: an approved trip
-- commits 500, spawns a per-diem reimbursement, and that reimbursement lands in
-- a locked payroll — without it, the same 500 would be subtracted twice.
--
-- Actuals are deliberately NOT stored here: payroll_items / reimbursements are
-- already the source of truth, and a materialised copy could only drift.

ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'BUDGET_CATEGORY';

CREATE TABLE IF NOT EXISTS "budgets" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"          VARCHAR(200) NOT NULL,
    "fiscal_year"   INTEGER      NOT NULL,
    "start_date"    DATE         NOT NULL,
    "end_date"      DATE         NOT NULL,
    "branch_id"     UUID         NOT NULL,
    "currency"      VARCHAR(3)   NOT NULL DEFAULT 'OMR',
    "status"        VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID         NOT NULL,
    "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "budgets_branch_id_fiscal_year_name_key"
    ON "budgets" ("branch_id", "fiscal_year", "name");
CREATE INDEX IF NOT EXISTS "budgets_branch_id_status_idx"
    ON "budgets" ("branch_id", "status");

CREATE TABLE IF NOT EXISTS "budget_lines" (
    "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
    "budget_id"      UUID          NOT NULL,
    "department_id"  UUID,
    "category"       VARCHAR(100)  NOT NULL,
    "planned_amount" DECIMAL(15,2) NOT NULL,
    "notes"          TEXT,
    "created_at"     TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

-- NULL department_id = the company-wide fallback line for a category.
-- Postgres treats NULLs as distinct in a plain unique index, so the fallback
-- line needs its own partial unique index to stay singular.
CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_budget_dept_category_key"
    ON "budget_lines" ("budget_id", "department_id", "category")
    WHERE "department_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_budget_category_companywide_key"
    ON "budget_lines" ("budget_id", "category")
    WHERE "department_id" IS NULL;
CREATE INDEX IF NOT EXISTS "budget_lines_budget_id_idx"
    ON "budget_lines" ("budget_id");

CREATE TABLE IF NOT EXISTS "budget_commitments" (
    "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
    "budget_line_id" UUID          NOT NULL,
    "source_type"    VARCHAR(30)   NOT NULL,
    "source_id"      UUID          NOT NULL,
    "amount"         DECIMAL(15,2) NOT NULL,
    "status"         VARCHAR(20)   NOT NULL DEFAULT 'OPEN',
    "committed_at"   TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at"    TIMESTAMP(6),
    "resolved_note"  TEXT,

    CONSTRAINT "budget_commitments_pkey" PRIMARY KEY ("id")
);

-- Idempotency: replaying an approval updates the existing commitment rather
-- than adding a second one.
CREATE UNIQUE INDEX IF NOT EXISTS "budget_commitments_source_type_source_id_key"
    ON "budget_commitments" ("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "budget_commitments_budget_line_id_status_idx"
    ON "budget_commitments" ("budget_line_id", "status");

DO $$
BEGIN
    ALTER TABLE "budgets" ADD CONSTRAINT "budgets_branch_id_fkey"
        FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey"
        FOREIGN KEY ("budget_id") REFERENCES "budgets"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_department_id_fkey"
        FOREIGN KEY ("department_id") REFERENCES "departments"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "budget_commitments" ADD CONSTRAINT "budget_commitments_budget_line_id_fkey"
        FOREIGN KEY ("budget_line_id") REFERENCES "budget_lines"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
