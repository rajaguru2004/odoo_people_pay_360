-- Partial unique indexes that `prisma db push` cannot create.
--
-- WHY THIS FILE EXISTS
--
-- The e2e template is built with `db push`, not `migrate deploy`, because the
-- migration history cannot replay from empty (see scripts/e2e-db.sh for the
-- detail). `db push` builds the schema from schema.prisma — and Prisma cannot
-- express a PARTIAL unique index, so every one of these lives only in raw SQL
-- inside a migration and is silently absent from the test database.
--
-- That gap is not cosmetic. Each of these enforces an "at most one active /
-- pending / current X" rule. Without them the test database is WEAKER than
-- production: two concurrent writes that production refuses at the index both
-- succeed here, so a concurrency test either passes for the wrong reason or
-- reports a race that cannot actually happen in production.
--
-- It was found by `VISA-API-28`, which observed an employee ending up with two
-- current visas for the same country — impossible in DEV and PROD, routine here.
--
-- Every statement is IF NOT EXISTS so this is safe to re-run, and safe if the
-- template is ever built by a path that does apply the migrations.
--
-- Keep in sync when a migration adds a new partial unique index:
--   grep -rn "CREATE UNIQUE INDEX" prisma/migrations/*/migration.sql | grep -i where

-- ── People ──────────────────────────────────────────────────────────────────
-- Exactly one current legal document per (employee, category, country).
CREATE UNIQUE INDEX IF NOT EXISTS "employee_legal_documents_current_unique"
  ON "employee_legal_documents" ("employee_id", "category", "country")
  WHERE "is_current" = true;

-- ── Banking ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_active_bank_detail"
  ON "employee_bank_details" ("employee_id")
  WHERE "is_active";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pending_bank_change"
  ON "bank_change_requests" ("employee_id")
  WHERE "status" = 'PENDING';

-- ── Calendar ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "holidays_date_global_uq"
  ON "holidays" ("date")
  WHERE "branch_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "holidays_date_branch_uq"
  ON "holidays" ("date", "branch_id")
  WHERE "branch_id" IS NOT NULL;

-- One work schedule per (employee, date, start_time), with NULL start times
-- colliding rather than being distinct — so a day carries at most one FLEXIBLE
-- shift, at most one shift beginning at any given time, and any number of
-- non-overlapping fixed shifts (a split day). Prisma cannot express
-- NULLS NOT DISTINCT, so `db push` never creates it.
CREATE UNIQUE INDEX IF NOT EXISTS "work_schedules_employee_date_start_uq"
  ON "work_schedules" ("employee_id", "date", "start_time")
  NULLS NOT DISTINCT;

-- ── Overtime policy ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_policies_default_active_key"
  ON "overtime_policies" ("is_default")
  WHERE "is_default" AND "is_active";

CREATE UNIQUE INDEX IF NOT EXISTS "overtime_policies_emptype_active_key"
  ON "overtime_policies" ("employment_type")
  WHERE "employment_type" IS NOT NULL AND "is_active";

-- ── Approvals ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "approval_workflows_request_type_active_key"
  ON "approval_workflows" ("request_type")
  WHERE "is_active";

-- ── Assets ──────────────────────────────────────────────────────────────────
-- One open assignment per asset: the rule the offboarding clearance gate reads.
CREATE UNIQUE INDEX IF NOT EXISTS "asset_assignments_one_open_per_asset"
  ON "asset_assignments" ("asset_id")
  WHERE "returned_at" IS NULL;

-- ── Loans ───────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_deductions_schedule_live_uq"
  ON "advance_loan_deductions" ("schedule_id")
  WHERE "schedule_id" IS NOT NULL AND "status" IN ('PENDING', 'PAID');

CREATE UNIQUE INDEX IF NOT EXISTS "advance_loan_deductions_request_period_uq"
  ON "advance_loan_deductions" ("request_id", "year", "month")
  WHERE "schedule_id" IS NULL AND "status" IN ('PENDING', 'PAID');

-- ── Profile templates ───────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_company"
  ON "profile_templates" ((true))
  WHERE "scope" = 'COMPANY' AND "is_active";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_branch"
  ON "profile_templates" ("branch_id")
  WHERE "scope" = 'BRANCH' AND "is_active" AND "branch_id" IS NOT NULL;

-- ── Budgeting ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_budget_dept_category_key"
  ON "budget_lines" ("budget_id", "department_id", "category")
  WHERE "department_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_budget_category_companywide_key"
  ON "budget_lines" ("budget_id", "category")
  WHERE "department_id" IS NULL;

-- ── WPS ─────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_wps_generating_per_payroll"
  ON "wps_files" ("payroll_id")
  WHERE "status" = 'GENERATING';

-- ── Payroll period uniqueness ───────────────────────────────────────────────
-- Not a PARTIAL index but an EXPRESSION one, which `db push` cannot express
-- either — so it was absent here for the same reason and with the same effect.
-- Copied verbatim from migration 20260805100000_fix_payroll_period_uniqueness.
--
-- Found by PR-API-12: two simultaneous `POST /payrolls` for the same period and
-- branch BOTH returned 201 against the test database. The service's own
-- duplicate check is a read-then-write and cannot survive a race; this index is
-- the only thing that actually holds the line, and it did not exist here. Every
-- Playwright run and every CI run was therefore executing against a database
-- where a payroll period could be paid twice.
--
-- COALESCE, because Postgres treats NULLs as distinct: a plain unique index over
-- (month, year, branch_id, batch_id, version) would permit unlimited duplicates
-- for company-wide (branch_id IS NULL) or unbatched (batch_id IS NULL) runs.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_period_branch_batch_version"
  ON "payrolls" (
    "month",
    "year",
    COALESCE("branch_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("batch_id",  '00000000-0000-0000-0000-000000000000'::uuid),
    "version"
  );

-- ---------------------------------------------------------------------------
-- Sequences
-- ---------------------------------------------------------------------------
-- Same class of gap as the partial indexes above: `prisma db push` builds the
-- schema from schema.prisma, and a bare SEQUENCE is not expressible there — it
-- exists only in migration 20260803170000_add_letters_grievance_vault. Without
-- it `LettersService.nextSerial()` answers 500 (`relation "letter_serial_seq"
-- does not exist`) and the whole letters half of
-- letters-grievance-vault.e2e-spec.ts fails against a freshly built template.
--
-- Serial numbers are printed on the letter and used for verification, so they
-- must never collide under concurrency. SELECT MAX(...)+1 does not guarantee
-- that; a sequence does.
CREATE SEQUENCE IF NOT EXISTS "letter_serial_seq" START 1;

-- Same gap again, for project codes. `ProjectsService` mints `PROJ-####` from
-- this sequence (migration 20260818120000_add_project_code_sequence); without
-- it every `POST /projects` answers 500 (`relation "project_code_seq" does not
-- exist`) against a freshly built template.
--
-- It replaces a parse of the LEXICAL maximum `project_code`, which any code
-- sorting above 'PROJ-' turned into the literal string `PROJ-0NaN` — and since
-- `project_code` is UNIQUE, into a permanent 500 on every later create. The e2e
-- fixtures seed `WP…` codes, so the template is exactly where that bites.
-- Finding R6.
CREATE SEQUENCE IF NOT EXISTS "project_code_seq" START 1;

DO $$
DECLARE
  already_used boolean;
  start_at     bigint;
BEGIN
  SELECT last_value IS NOT NULL
    INTO already_used
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'project_code_seq';

  IF already_used IS NOT NULL AND NOT already_used THEN
    SELECT COALESCE(MAX(CAST(substring(project_code FROM 6) AS BIGINT)), 0) + 1
      INTO start_at
      FROM projects
     WHERE project_code ~ '^PROJ-[0-9]+$';

    PERFORM setval('project_code_seq', GREATEST(start_at, 1), false);
  END IF;
END $$;

-- ── Assets — the two objects `db push` DOES create, asserted anyway ──────────
--
-- `asset_items_branch_id_asset_tag_key` (per-branch tag uniqueness, R2) and the
-- `AssetStatus` enum (R15) are both expressible in schema.prisma, so `db push`
-- creates them when it builds this template from empty and there is nothing for
-- this file to add. They are ASSERTED here rather than created, because the
-- reason this file exists is that the test database was once WEAKER than
-- production and nothing said so — H3 asked the e2e template and passed, while
-- `letter_serial_seq` was missing from the file that provisions production
-- (R80), and Phase 4 found the payroll uniqueness index missing here only.
--
-- A silently absent unique index does not fail a suite: it makes two writes
-- that production refuses both succeed, so a concurrency case passes for the
-- wrong reason. A silently absent enum is worse — the whole point of R15 is
-- that the DTO is not the only writer, and a VarChar column accepts everything
-- the enum refuses. Either regression now fails the template BUILD, loudly and
-- at the moment it is introduced, instead of surfacing as a test that lies.
DO $$
BEGIN
  IF to_regclass('"asset_items_branch_id_asset_tag_key"') IS NULL THEN
    RAISE EXCEPTION
      'asset_items_branch_id_asset_tag_key is missing from the e2e template. `@@unique([branchId, assetTag])` has gone from schema.prisma, or `db push` did not apply it — either way this template is weaker than production and every per-branch tag case would pass for the wrong reason.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetStatus') THEN
    RAISE EXCEPTION
      'The AssetStatus enum is missing from the e2e template. asset_items.status has gone back to free text, so the database accepts every value the DTO refuses (R15) and nothing in the suite would notice.';
  END IF;

  IF to_regclass('"asset_items_asset_tag_key"') IS NOT NULL THEN
    RAISE EXCEPTION
      'The GLOBAL unique on asset_items.asset_tag is still present. Two branches cannot both hold "LAP-001" (R2), and the per-branch cases will fail against a template that still enforces the old rule.';
  END IF;
END
$$;

-- ── Accounting ──────────────────────────────────────────────────────────────
-- Exactly one mapping per (event, component) at each level: one per branch, and
-- one company-wide. `branch_id` is nullable, so the plain @@unique in
-- schema.prisma cannot enforce the company-wide half — two NULLs are never
-- equal in Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_branch_key"
  ON "ledger_mappings" ("event", "component", "branch_id")
  WHERE "branch_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_global_key"
  ON "ledger_mappings" ("event", "component")
  WHERE "branch_id" IS NULL;

-- ── Loans: the reference sequence ───────────────────────────────────────────
-- `prisma db push` cannot create a bare SEQUENCE, and loan references are
-- minted with `nextval` — without this, every native loan creation fails.
CREATE SEQUENCE IF NOT EXISTS "loan_reference_seq" START WITH 1 INCREMENT BY 1;

-- ── Payroll: leave encashment ───────────────────────────────────────────────
-- One live request per employee, leave type and year. Two competing requests
-- for the same balance is how an employee is paid for the same days twice.
--
-- Lives only in migration 20260901160000 because the predicate is a partial
-- index Prisma cannot express, so `db push` never created it here and
-- `PE-IN-43` watched a second live request succeed against a database weaker
-- than production.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_leave_encashment_live"
  ON "leave_encashment_requests" ("employee_id", "leave_type_key", "year")
  WHERE "status" IN ('PENDING', 'APPROVED');

-- ── Payroll: gratuity rule bands ────────────────────────────────────────────
-- Not partial indexes but the same failure: CHECK and EXCLUDE constraints are
-- not expressible in schema.prisma either, so `db push` silently omits them and
-- the rule table accepts bands production refuses. `GratuityService` only
-- TRANSLATES these refusals into sentences — it does not re-implement them, so
-- without the constraint there is no refusal to translate.
--
-- A band that ends before it starts matches nobody and contributes nothing to a
-- provision, silently (PE-EOSB-23).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gratuity_rule_band_ordered') THEN
    ALTER TABLE "gratuity_rules"
      ADD CONSTRAINT "gratuity_rule_band_ordered"
      CHECK ("to_years" IS NULL OR "to_years" > "from_years");
  END IF;
END
$$;

-- Two active rules covering one year of service for the same country and class
-- would make an entitlement depend on which row was read first — and it only
-- ever surfaces years later, when somebody with enough service leaves
-- (PE-EOSB-21). A sort order in the service layer cannot prevent it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gratuity_rule_no_overlap') THEN
    ALTER TABLE "gratuity_rules"
      ADD CONSTRAINT "gratuity_rule_no_overlap"
      EXCLUDE USING gist (
        "country" WITH =,
        "nationality_class" WITH =,
        numrange("from_years", COALESCE("to_years", 'Infinity'::numeric), '[)') WITH &&,
        daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[)') WITH &&
      ) WHERE ("is_active");
  END IF;
END
$$;

-- ── Document engine ─────────────────────────────────────────────────────────
-- The publish concurrency rule, and the COMPANY-vs-BRANCH template uniqueness.
-- Partial, so `prisma db push` cannot express them; without these the e2e
-- template database would permit two published versions of one template and
-- the "concurrent publish answers 409" case would pass for the wrong reason.
CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_published"
  ON "document_template_versions" ("template_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_draft"
  ON "document_template_versions" ("template_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_branch_key"
  ON "document_templates" ("type_key", "locale", "branch_id")
  WHERE "branch_id" IS NOT NULL AND "is_active" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_company_key"
  ON "document_templates" ("type_key", "locale")
  WHERE "branch_id" IS NULL AND "is_active" = true;

CREATE SEQUENCE IF NOT EXISTS "document_serial_seq" START WITH 1 INCREMENT BY 1;
