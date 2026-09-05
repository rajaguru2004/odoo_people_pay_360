-- ─── WHY ────────────────────────────────────────────────────────────────────
--
-- Gap report §1, the single largest gap in the module: there is no accounting,
-- GL or journal anywhere in the product, and `loan_transactions.journal_ref` is
-- declared and INDEXED and referenced by nothing. The whole of catalogue §14 —
-- loan receivable ledger, payroll liability posting, interest income, write-off
-- and settlement journals, rollback and duplicate-journal handling — was 0%
-- testable because there was nothing to test.
--
-- ─── SHAPE ──────────────────────────────────────────────────────────────────
--
-- Deliberately small. `LoanTransaction` is already the correct feed: append
-- only, typed by event, split into principal/interest/fee, with a reversal
-- link. What was missing is the posting side, so that is all this adds:
--
--   ledger_accounts  — the accounts this product needs to NAME
--   ledger_mappings  — which accounts an event posts to, as data rather than
--                      hard-coded strings, so an unmapped event is a clear
--                      refusal instead of a guess
--   journal_entries  — one balanced entry per source event
--   journal_lines    — its debit/credit lines
--
-- A full chart of accounts, fiscal periods and a trial balance belong to a
-- finance system, not to an HR product, and are deliberately NOT here.
--
-- ─── IDEMPOTENCY ────────────────────────────────────────────────────────────
--
-- `journal_entries (source_type, source_id, status)` is unique. That single
-- index is what makes posting replayable: a second attempt to post the same
-- loan transaction loses on it instead of duplicating the entry, which is the
-- catalogue's "duplicate journal" case answered structurally.

CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "code"       VARCHAR(40) NOT NULL,
  "name"       VARCHAR(200) NOT NULL,
  "type"       VARCHAR(20) NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "branch_id"  UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_accounts_code_key"
  ON "ledger_accounts" ("code");
CREATE INDEX IF NOT EXISTS "ledger_accounts_is_active_code_idx"
  ON "ledger_accounts" ("is_active", "code");

DO $$ BEGIN
  ALTER TABLE "ledger_accounts"
    ADD CONSTRAINT "ledger_accounts_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ledger_mappings" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "event"             VARCHAR(40) NOT NULL,
  "branch_id"         UUID,
  "debit_account_id"  UUID NOT NULL,
  "credit_account_id" UUID NOT NULL,
  "component"         VARCHAR(20) NOT NULL DEFAULT 'TOTAL',
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_mappings_pkey" PRIMARY KEY ("id")
);

-- Partial unique indexes, not a plain UNIQUE: Postgres does not treat two
-- NULLs as equal, so a company-wide mapping (branch_id IS NULL) would
-- otherwise be duplicable without limit. Same trick the branch-scoped tables
-- in this schema already use.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_branch_key"
  ON "ledger_mappings" ("event", "component", "branch_id")
  WHERE "branch_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_mappings_event_component_global_key"
  ON "ledger_mappings" ("event", "component")
  WHERE "branch_id" IS NULL;
CREATE INDEX IF NOT EXISTS "ledger_mappings_event_is_active_idx"
  ON "ledger_mappings" ("event", "is_active");

DO $$ BEGIN
  ALTER TABLE "ledger_mappings"
    ADD CONSTRAINT "ledger_mappings_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ledger_mappings"
    ADD CONSTRAINT "ledger_mappings_debit_account_id_fkey"
    FOREIGN KEY ("debit_account_id") REFERENCES "ledger_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ledger_mappings"
    ADD CONSTRAINT "ledger_mappings_credit_account_id_fkey"
    FOREIGN KEY ("credit_account_id") REFERENCES "ledger_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "journal_entries" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "reference"      VARCHAR(60) NOT NULL,
  "entry_date"     DATE NOT NULL,
  "narration"      TEXT,
  "source_type"    VARCHAR(40) NOT NULL,
  "source_id"      UUID NOT NULL,
  "branch_id"      UUID,
  "status"         VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  "reversal_of_id" UUID,
  "posted_by_id"   UUID,
  "posted_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_reference_key"
  ON "journal_entries" ("reference");
-- The replay guard.
CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_source_type_source_id_status_key"
  ON "journal_entries" ("source_type", "source_id", "status");
CREATE INDEX IF NOT EXISTS "journal_entries_entry_date_idx"
  ON "journal_entries" ("entry_date");

DO $$ BEGIN
  ALTER TABLE "journal_entries"
    ADD CONSTRAINT "journal_entries_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "journal_entries"
    ADD CONSTRAINT "journal_entries_reversal_of_id_fkey"
    FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "journal_lines" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "entry_id"          UUID NOT NULL,
  "debit_account_id"  UUID NOT NULL,
  "credit_account_id" UUID NOT NULL,
  "amount"            DECIMAL(12,2) NOT NULL,
  "component"         VARCHAR(20) NOT NULL DEFAULT 'TOTAL',
  "narration"         TEXT,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "journal_lines_entry_id_idx"
  ON "journal_lines" ("entry_id");

DO $$ BEGIN
  ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_debit_account_id_fkey"
    FOREIGN KEY ("debit_account_id") REFERENCES "ledger_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_credit_account_id_fkey"
    FOREIGN KEY ("credit_account_id") REFERENCES "ledger_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
