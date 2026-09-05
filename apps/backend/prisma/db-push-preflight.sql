-- ─────────────────────────────────────────────────────────────────────────────
-- Pre-flight DDL — runs immediately BEFORE `prisma db push` on container start.
--
-- WHY THIS FILE EXISTS
--   `db push` refuses to add a UNIQUE constraint to a table that already holds
--   rows: it cannot know ahead of time whether duplicates exist, so it aborts
--   with "There might be data loss ... use --accept-data-loss" and the container
--   dies on `set -e`. Passing --accept-data-loss in the entrypoint is NOT the
--   fix — that flag is global, so it would also silently authorise dropping
--   columns and tables for every future schema change.
--
--   Instead, every constraint `db push` considers risky is applied here first,
--   idempotently and with an explicit duplicate check. Once the object exists in
--   the database, `db push` sees no diff for it, prints no warning, and proceeds.
--
-- RULES FOR ANYTHING ADDED HERE
--   * Must be safe to re-run on every single container start (IF NOT EXISTS /
--     guarded DO blocks — never a bare CREATE or DROP).
--   * Must never delete or rewrite row data. This file only adds structure.
--   * Must mirror schema.prisma exactly (same index name via `map:`), otherwise
--     Prisma reports drift and pushes it again.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── employees.attendance_external_id — attendance integrations ───────────────
-- Identity of an employee inside the branch's external attendance provider.
-- Unique per BRANCH, not globally: two providers at two branches may legitimately
-- reuse the same external id string for different people. Postgres allows
-- unlimited NULLs in a unique index, so unlinked employees are unaffected.

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "attendance_external_id" VARCHAR(100);

DO $$
DECLARE
  duplicate_sample TEXT;
BEGIN
  -- Already applied (fresh DB, or a previous start) — nothing to do.
  IF to_regclass('"unique_branch_external_attendance_id"') IS NOT NULL THEN
    RETURN;
  END IF;

  -- Rows with a NULL on either side can never collide in a unique index, so
  -- only fully-populated pairs can block the index.
  SELECT string_agg(format('branch=%s external_id=%s (%s rows)', branch_id, attendance_external_id, n), ', ')
    INTO duplicate_sample
    FROM (
      SELECT "branch_id" AS branch_id,
             "attendance_external_id" AS attendance_external_id,
             COUNT(*) AS n
        FROM "employees"
       WHERE "attendance_external_id" IS NOT NULL
         AND "branch_id" IS NOT NULL
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
       LIMIT 10
    ) d;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create unique_branch_external_attendance_id: employees.attendance_external_id is duplicated within a branch. Clear the duplicates (set the wrong one to NULL) and restart. Offenders: %',
      duplicate_sample;
  END IF;

  CREATE UNIQUE INDEX "unique_branch_external_attendance_id"
    ON "employees" ("branch_id", "attendance_external_id");
END
$$;

CREATE INDEX IF NOT EXISTS "employees_attendance_external_id_idx"
  ON "employees" ("attendance_external_id");


-- ── advance_loan_requests.reference_no — unique loan reference ────────────────
-- Human-readable reference (e.g. LN-2026-000123). NULL for legacy rows that
-- pre-date v2; NULLs never collide in a unique constraint so they are safe.
-- Prisma names a single-field @unique constraint as <table>_<column>_key.
--
-- Step 1: ensure the column exists before we try to constrain it.
--   On a fresh DB or one that pre-dates v2, the column may not exist yet.
--   ADD COLUMN IF NOT EXISTS is idempotent and runs instantly on an empty column.

ALTER TABLE "advance_loan_requests"
  ADD COLUMN IF NOT EXISTS "reference_no" VARCHAR(40);

-- Step 2: add the unique constraint (skipped if already present).

DO $$
DECLARE
  duplicate_sample TEXT;
BEGIN
  -- Already applied — nothing to do. Checked as a RELATION, not as a
  -- pg_constraint row: a database provisioned by `db push` gets a plain
  -- CREATE UNIQUE INDEX under this name with no constraint backing it, so a
  -- pg_constraint-only guard sees nothing, falls through, and ADD CONSTRAINT
  -- dies on the name collision ("relation ... already exists"), killing the
  -- container on `set -e`. Index and constraint share one namespace, so
  -- to_regclass catches both spellings. Either one enforces the uniqueness
  -- Prisma expects and leaves `db push` with no diff.
  IF to_regclass('"advance_loan_requests_reference_no_key"') IS NOT NULL THEN
    RETURN;
  END IF;

  -- Only non-NULL values can create a collision in a unique constraint.
  SELECT string_agg(format('reference_no=%s (%s rows)', reference_no, n), ', ')
    INTO duplicate_sample
    FROM (
      SELECT "reference_no", COUNT(*) AS n
        FROM "advance_loan_requests"
       WHERE "reference_no" IS NOT NULL
       GROUP BY 1
      HAVING COUNT(*) > 1
       LIMIT 10
    ) d;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create advance_loan_requests_reference_no_key: reference_no has duplicate values. '
      'De-duplicate the rows and restart. Offenders: %',
      duplicate_sample;
  END IF;

  ALTER TABLE "advance_loan_requests"
    ADD CONSTRAINT "advance_loan_requests_reference_no_key" UNIQUE ("reference_no");
END
$$;


-- ── Employee Profile Template — objects `db push` cannot create ─────────────
-- Partial indexes and GIN indexes are inexpressible in schema.prisma, so these
-- live in migration 20260807120000 and nowhere else. The container never runs
-- `migrate deploy` — docker-entrypoint.sh runs this file and then `db push` —
-- so without this block a deployed environment silently loses the "at most one
-- active template per scope" guarantee that the resolution chain assumes,
-- leaving only the service's ConflictException, which races.
--
-- Guarded on object existence rather than written bare: this file runs BEFORE
-- `db push`, so on the first start after this feature ships, profile_templates
-- does not exist yet. Bare DDL would abort the script and kill the container on
-- `set -e`. Skipping quietly means the indexes appear on the next start, once
-- `db push` has created the table — which is exactly the sequence a rolling
-- deploy produces anyway.
DO $$
BEGIN
  IF to_regclass('"profile_templates"') IS NULL THEN
    RAISE NOTICE 'profile_templates not created yet — template indexes deferred to the next start';
    RETURN;
  END IF;

  -- At most one active COMPANY template. ((true)) is the idiom for a
  -- whole-table singleton predicate.
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_company"
    ON "profile_templates" ((true))
    WHERE "scope" = 'COMPANY' AND "is_active";

  -- At most one active template per branch.
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_branch"
    ON "profile_templates" ("branch_id")
    WHERE "scope" = 'BRANCH' AND "is_active" AND "branch_id" IS NOT NULL;
END
$$;

-- Containment queries on the JSONB bag. Not in schema.prisma either, so a
-- db push-provisioned database was sequential-scanning every custom_fields
-- lookup. Guarded on the COLUMN, which `db push` adds, not on the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'employees' AND column_name = 'custom_fields'
  ) THEN
    RAISE NOTICE 'employees.custom_fields not added yet — GIN index deferred to the next start';
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS "employees_custom_fields_gin_idx"
    ON "employees" USING GIN ("custom_fields");
END
$$;

-- Kill switch, OFF. Seeded here as well as in the migration so a db push
-- environment starts with the row present and the admin toggle can read its
-- own state instead of rendering OFF regardless.
INSERT INTO "system_settings" ("key", "value")
VALUES ('employee_template_enabled', 'false')
ON CONFLICT ("key") DO NOTHING;

-- ── projects.project_code — the sequence the codes are minted from ───────────
-- `ProjectsService.nextProjectCode()` reads `nextval('project_code_seq')`.
-- A bare SEQUENCE is not expressible in schema.prisma, so `db push` never
-- creates it and a db push-provisioned environment would answer 500 on every
-- `POST /projects` (`relation "project_code_seq" does not exist`). It is here,
-- rather than only in migration 20260818120000_add_project_code_sequence,
-- because production is provisioned by this entrypoint.
--
-- It replaces a generator that parsed the LEXICAL maximum `project_code` and so
-- emitted the literal string 'PROJ-0NaN' the moment any code sorting above
-- 'PROJ-' existed — which, `project_code` being UNIQUE, permanently 500'd every
-- create after the first. Finding R6.
CREATE SEQUENCE IF NOT EXISTS "project_code_seq" START 1;

-- Seeded past the well-formed codes already in the table, and ONLY while the
-- sequence has never been read, so re-running on every container start can
-- never rewind it beneath a code it has already issued.
DO $$
DECLARE
  already_used boolean;
  start_at     bigint;
BEGIN
  -- This file runs BEFORE `db push`, so on a virgin database the table does
  -- not exist yet. Nothing to seed past in that case; the sequence's own
  -- START 1 is already correct.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'projects'
  ) THEN
    RETURN;
  END IF;

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
END
$$;

-- ── letter_requests.serial_number — the sequence the serials are minted from ─
-- `LettersService.nextSerial()` reads `nextval('letter_serial_seq')`, and the
-- serial is printed on the PDF and is what `/letters/verify/:serial` resolves.
--
-- Same exposure the project-code block above documents, and it predates it:
-- a bare SEQUENCE is not expressible in schema.prisma, so `db push` never
-- creates it. The sequence existed only in migration
-- 20260803170000_add_letters_grievance_vault and in prisma/e2e-partial-indexes.sql
-- — but production is provisioned by this entrypoint (preflight + db push,
-- never `migrate deploy`), so a freshly provisioned deployment would answer 500
-- on the FIRST letter anyone tried to issue, with
-- `relation "letter_serial_seq" does not exist`.
--
-- Found while fixing R6; the letters half was the same bug one module over.
CREATE SEQUENCE IF NOT EXISTS "letter_serial_seq" START 1;

-- Seeded past the serials already issued, and ONLY while the sequence has never
-- been read, so re-running on every container start cannot rewind it beneath a
-- serial already printed on a letter. Serials are `PREFIX-YYYY-NNNNN`; the
-- counter is the trailing group.
DO $$
DECLARE
  already_used boolean;
  start_at     bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'letter_requests'
  ) THEN
    RETURN;
  END IF;

  SELECT last_value IS NOT NULL
    INTO already_used
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'letter_serial_seq';

  IF already_used IS NOT NULL AND NOT already_used THEN
    SELECT COALESCE(MAX(CAST(substring(serial_number FROM '([0-9]+)$') AS BIGINT)), 0) + 1
      INTO start_at
      FROM letter_requests
     WHERE serial_number ~ '[0-9]+$';

    PERFORM setval('letter_serial_seq', GREATEST(start_at, 1), false);
  END IF;
END
$$;

-- ── asset_items — per-branch tag uniqueness and a real status enum ───────────
--
-- Two schema changes that `db push` CAN express (a composite `@@unique` and an
-- enum) but cannot safely APPLY to a table that already holds rows: it flags
-- both as possible data loss and aborts, which kills the container on `set -e`.
-- Reconciling the data here, before the push, is what leaves `db push` with no
-- diff and nothing to warn about. Findings R2 and R15.
--
-- Every block below returns quietly when `asset_items` does not exist. This
-- file runs BEFORE `db push`, so on a virgin database the table is not there
-- yet — and it does not need to be: `db push` will then create the column as
-- `AssetStatus` and the index as part of the table, which is exactly the end
-- state these blocks produce on an existing one.

-- Step 1 — the enum type. Prisma names the PG type after the Prisma enum
-- verbatim (`enum AssetStatus` → type "AssetStatus"), so this must match or
-- Prisma reports drift and pushes its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetStatus') THEN
    CREATE TYPE "AssetStatus" AS ENUM (
      'AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED'
    );
  END IF;
END
$$;

-- Step 2 — convert asset_items.status from VARCHAR(20) to the enum.
--
-- The DTO's `@IsIn(ASSET_STATUSES)` guarded exactly one door. Anything written
-- by a seed, a backfill, an MCP tool or a future endpoint was stored, served
-- back by the API, counted in `/assets/summary`, and unreachable through
-- `?status=` — the filter refuses the value the row holds. Finding R15.
--
-- An out-of-range value REFUSES the boot rather than being mapped. Every
-- mapping is a guess with a cost: AVAILABLE returns a possibly-lost item to the
-- assignable pool, RETIRED takes a live one out, and either way the original
-- value is gone and unrecoverable. A refusal is loud, reversible and names the
-- rows; a silent rewrite is none of those. Same contract as the
-- unique_branch_external_attendance_id block above.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_items'
       AND column_name = 'status'
       AND data_type = 'character varying'
  ) THEN
    RETURN;  -- table not created yet, or already converted
  END IF;

  SELECT string_agg(format('%L (%s rows)', status, n), ', ')
    INTO offenders
    FROM (
      SELECT "status", COUNT(*) AS n
        FROM "asset_items"
       WHERE "status" NOT IN ('AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED')
       GROUP BY 1
       LIMIT 20
    ) d;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot convert asset_items.status to the AssetStatus enum: rows hold a value outside AVAILABLE|ASSIGNED|IN_REPAIR|LOST|RETIRED. Decide what each one means and UPDATE it to one of the five, then restart. This will not guess: guessing either returns a lost item to the assignable pool or retires a live one. Offenders: %',
      offenders;
  END IF;

  ALTER TABLE "asset_items" ALTER COLUMN "status" DROP DEFAULT;
  ALTER TABLE "asset_items"
    ALTER COLUMN "status" TYPE "AssetStatus" USING ("status"::"AssetStatus");
  ALTER TABLE "asset_items"
    ALTER COLUMN "status" SET DEFAULT 'AVAILABLE'::"AssetStatus";
END
$$;

-- Step 3 — asset_tag: global unique becomes unique per branch.
--
-- Branches run their own asset numbering, and two sites both holding a
-- "LAP-001" is normal. While the constraint was global, the second one to be
-- registered was refused with a 409 quoting a tag that the branch middleware
-- hides from the person reading the message — so the search the error invites
-- returns nothing and there is no action they can take. Finding R2.
DO $$
DECLARE
  duplicate_sample TEXT;
BEGIN
  IF to_regclass('"asset_items"') IS NULL THEN
    RAISE NOTICE 'asset_items not created yet — per-branch tag index deferred to the next start';
    RETURN;
  END IF;

  IF to_regclass('"asset_items_branch_id_asset_tag_key"') IS NOT NULL THEN
    RETURN;  -- already applied
  END IF;

  -- Only reachable if the global unique has already been dropped by hand;
  -- while it stands, a per-branch duplicate cannot exist. Written anyway,
  -- because this file must be safe on a database that has been touched.
  SELECT string_agg(format('branch=%s asset_tag=%s (%s rows)', branch_id, asset_tag, n), ', ')
    INTO duplicate_sample
    FROM (
      SELECT "branch_id", "asset_tag", COUNT(*) AS n
        FROM "asset_items"
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
       LIMIT 10
    ) d;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create asset_items_branch_id_asset_tag_key: asset_tag is duplicated within a branch. Re-tag the duplicates and restart. Offenders: %',
      duplicate_sample;
  END IF;

  -- The old global unique is a CONSTRAINT on a migrate-built database and a
  -- bare INDEX on a `db push`-built one; index and constraint share a
  -- namespace, so both spellings must be handled or the CREATE below dies on
  -- the name it failed to drop. Same trap the reference_no block documents.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"asset_items"'::regclass
       AND conname = 'asset_items_asset_tag_key'
  ) THEN
    ALTER TABLE "asset_items" DROP CONSTRAINT "asset_items_asset_tag_key";
  ELSE
    DROP INDEX IF EXISTS "asset_items_asset_tag_key";
  END IF;

  CREATE UNIQUE INDEX "asset_items_branch_id_asset_tag_key"
    ON "asset_items" ("branch_id", "asset_tag");
END
$$;

-- ── Accounting: partial uniques `db push` cannot create ─────────────────────
-- See prisma/e2e-partial-indexes.sql for why these are partial.
--
-- Guarded on the table existing: this file runs BEFORE `db push`, so on a
-- brand-new database `ledger_mappings` has not been created yet. The indexes
-- are then made by the migration (or by the e2e partial-index file) instead,
-- and this block becomes a no-op on the next start.
DO $$ BEGIN
  IF to_regclass('"ledger_mappings"') IS NULL THEN
    RETURN;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_branch_key"
    ON "ledger_mappings" ("event", "component", "branch_id")
    WHERE "branch_id" IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_global_key"
    ON "ledger_mappings" ("event", "component")
    WHERE "branch_id" IS NULL;
END $$;

-- ── Loans: the reference sequence ───────────────────────────────────────────
-- `prisma db push` cannot create a bare SEQUENCE, and loan references are
-- minted with `nextval` — without this, every native loan creation fails.
CREATE SEQUENCE IF NOT EXISTS "loan_reference_seq" START WITH 1 INCREMENT BY 1;

-- ── Document engine: partial uniques and the serial sequence ────────────────
-- Guarded on the tables existing, for the same reason as ledger_mappings
-- above: this file runs BEFORE `db push`, so on a brand-new database these
-- tables do not exist yet and the migration (or e2e-partial-indexes.sql)
-- creates the indexes instead. The block becomes a no-op on the next start.
DO $$ BEGIN
  IF to_regclass('"document_template_versions"') IS NOT NULL THEN
    -- At most one DRAFT and one PUBLISHED version per template. This is the
    -- publish concurrency rule; a service-level check-then-write cannot
    -- promise it when two admins press Publish at the same moment.
    CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_published"
      ON "document_template_versions" ("template_id") WHERE "status" = 'PUBLISHED';
    CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_draft"
      ON "document_template_versions" ("template_id") WHERE "status" = 'DRAFT';
  END IF;

  IF to_regclass('"document_templates"') IS NOT NULL THEN
    -- Split in two because NULL never equals NULL in a unique index, so one
    -- index over (type_key, locale, branch_id) would allow unlimited duplicate
    -- COMPANY rows — the same trap ledger_mappings documents above.
    CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_branch_key"
      ON "document_templates" ("type_key", "locale", "branch_id")
      WHERE "branch_id" IS NOT NULL AND "is_active" = true;
    CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_company_key"
      ON "document_templates" ("type_key", "locale")
      WHERE "branch_id" IS NULL AND "is_active" = true;
  END IF;
END $$;

-- `prisma db push` cannot create a bare SEQUENCE, and engine document serials
-- are minted with `nextval` — same reason as loan_reference_seq above.
CREATE SEQUENCE IF NOT EXISTS "document_serial_seq" START WITH 1 INCREMENT BY 1;

-- Per-branch document identity. Nullable => inherit the company-wide setting.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(50);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "email" VARCHAR(150);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "cr_number" VARCHAR(50);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "vat_number" VARCHAR(50);
