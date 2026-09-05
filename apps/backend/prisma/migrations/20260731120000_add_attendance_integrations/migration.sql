-- External attendance provider framework.
--
-- A branch may delegate attendance capture to an outside system (the first one
-- being fusion-analytics for Taageer Finance HO / "TAGGER"). We mirror their
-- records into `attendances` read-only. Nothing about our own ESS check-in,
-- manual entry, auto-absent cron or leave flow changes.
--
-- Every change here is ADDITIVE and NULLABLE. No existing row, query or code
-- path changes meaning, so this migration is safe to apply to a populated
-- database and safe to re-run.
--
-- Deliberately VARCHAR over Postgres enums throughout (provider, status,
-- trigger, conflict_policy, attendances.source): ALTER TYPE ... ADD VALUE
-- cannot run inside a transaction, which makes an enum painful to extend when
-- vendor #2 arrives. Deliberately no CHECK constraints either — Prisma does not
-- model them, so one would show as permanent `prisma migrate diff` drift.
-- Validation lives in the DTOs (@IsIn) and the provider registry.

-- ── 1. Provenance on attendances ────────────────────────────────────────────
-- Without these the conflict guard cannot tell a synced row from a manual one,
-- and "never overwrite what a human entered" is unenforceable.
--
-- Left NULL on every existing row on purpose. NULL means "written before this
-- column existed" and the guard treats it as overwritable, EXCEPT where the
-- notes text matches the manual-entry default (see step 2).

ALTER TABLE "attendances"
  ADD COLUMN IF NOT EXISTS "source"       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "synced_at"    TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "attendances_source_date_idx"
  ON "attendances" ("source", "date");

-- ── 2. Backfill the provenance we can prove ─────────────────────────────────
-- Only rows whose notes are the exact literals written by the existing code
-- paths are classified. Everything else stays NULL rather than being guessed:
-- a wrong MANUAL label would permanently shield a row from ever being
-- corrected by the provider.
--
--   attendances.service.ts:1697  -> 'Manually entered by admin'
--   attendances.service.ts:1247  -> 'Auto-marked absent (no check-in)'
-- NULL-only guard, so re-running never relabels rows the app has since owned.

UPDATE "attendances"
   SET "source" = 'MANUAL'
 WHERE "source" IS NULL
   AND "notes" = 'Manually entered by admin';

UPDATE "attendances"
   SET "source" = 'AUTO'
 WHERE "source" IS NULL
   AND "notes" = 'Auto-marked absent (no check-in)';

UPDATE "attendances"
   SET "source" = 'LEAVE'
 WHERE "source" IS NULL
   AND "status" = 'LEAVE';

-- ── 3. External employee identity ───────────────────────────────────────────
-- The provider identifies people by an opaque string id. The sync auto-matches
-- it against employee_code on first sight and backfills this column, so the
-- steady state is a direct indexed lookup. Admins can also bind it by hand for
-- employees whose codes never matched.
--
-- Unique per BRANCH, not globally: two providers at two branches may
-- legitimately reuse the same external id string for different people.
-- Postgres allows unlimited NULLs in a unique index, so unlinked employees are
-- unaffected.

ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "attendance_external_id" VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_branch_external_attendance_id"
  ON "employees" ("branch_id", "attendance_external_id");

CREATE INDEX IF NOT EXISTS "employees_attendance_external_id_idx"
  ON "employees" ("attendance_external_id");

-- ── 4. Connection config ────────────────────────────────────────────────────
-- One row per branch. `provider` is a key into the in-code provider registry
-- and everything vendor-specific lives in `options` (jsonb), so adding a second
-- vendor needs no migration at all.
--
-- branch_id is UNIQUE, not merely indexed: two integrations on one branch would
-- race each other on the same (employee_id, date) attendance rows.
--
-- auth_secret_enc holds an AES-256-GCM payload (`v1:<iv>:<tag>:<ct>`) produced
-- by common/crypto/secret-crypto.ts. It is never returned to the browser — the
-- read projection exposes a boolean plus a masked hint. Decryption requires
-- SETTINGS_ENCRYPTION_KEY in the environment; a key that decrypts the database
-- cannot live inside that same database.

CREATE TABLE IF NOT EXISTS "attendance_integrations" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "branch_id"             UUID         NOT NULL,
  "provider"              VARCHAR(50)  NOT NULL,
  "display_name"          VARCHAR(100) NOT NULL,
  "enabled"               BOOLEAN      NOT NULL DEFAULT false,

  "base_url"              VARCHAR(255) NOT NULL,
  "auth_scheme"           VARCHAR(20)  NOT NULL DEFAULT 'header',
  "auth_header_name"      VARCHAR(100),
  "auth_secret_enc"       TEXT,

  "external_branch_id"    VARCHAR(100) NOT NULL,
  "external_tenant_id"    VARCHAR(50),
  "options"               JSONB,

  "conflict_policy"       VARCHAR(30)  NOT NULL DEFAULT 'PROVIDER_WINS_SAFE',
  "sync_interval_minutes" INTEGER      NOT NULL DEFAULT 15,
  "lookback_days"         INTEGER      NOT NULL DEFAULT 3,
  "auto_create_absent"    BOOLEAN      NOT NULL DEFAULT false,

  "last_sync_at"          TIMESTAMP(6),
  "last_sync_status"      VARCHAR(20),
  "last_sync_error"       TEXT,

  "created_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "attendance_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_integrations_branch_id_key"
  ON "attendance_integrations" ("branch_id");

CREATE INDEX IF NOT EXISTS "attendance_integrations_enabled_idx"
  ON "attendance_integrations" ("enabled");

-- Deleting a branch deletes its integration: the config is meaningless without
-- the branch, and holding a dangling row would block the branch delete.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_integrations_branch_id_fkey'
  ) THEN
    ALTER TABLE "attendance_integrations"
      ADD CONSTRAINT "attendance_integrations_branch_id_fkey"
      FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 5. Sync run history ─────────────────────────────────────────────────────
-- The operator-facing audit trail: which window was read, what was written, and
-- why anything was skipped. Kept out of audit_logs because these are system
-- events with no acting user, and because payroll depends on being able to see
-- at a glance whether a month actually synced (payrolls.service.ts refuses to
-- run a month with zero attendance rows).

CREATE TABLE IF NOT EXISTS "attendance_sync_runs" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "integration_id" UUID        NOT NULL,
  "trigger"        VARCHAR(20) NOT NULL,
  "window_start"   DATE        NOT NULL,
  "window_end"     DATE        NOT NULL,
  "started_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"    TIMESTAMP(6),
  "status"         VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  "fetched"        INTEGER     NOT NULL DEFAULT 0,
  "matched"        INTEGER     NOT NULL DEFAULT 0,
  "created"        INTEGER     NOT NULL DEFAULT 0,
  "updated"        INTEGER     NOT NULL DEFAULT 0,
  "skipped"        INTEGER     NOT NULL DEFAULT 0,
  "unmapped"       INTEGER     NOT NULL DEFAULT 0,
  "error_count"    INTEGER     NOT NULL DEFAULT 0,
  "details"        JSONB,
  "triggered_by"   UUID,

  CONSTRAINT "attendance_sync_runs_pkey" PRIMARY KEY ("id")
);

-- Descending on started_at: every read of this table is "the latest N runs".
CREATE INDEX IF NOT EXISTS "attendance_sync_runs_integration_id_started_at_idx"
  ON "attendance_sync_runs" ("integration_id", "started_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_sync_runs_integration_id_fkey'
  ) THEN
    ALTER TABLE "attendance_sync_runs"
      ADD CONSTRAINT "attendance_sync_runs_integration_id_fkey"
      FOREIGN KEY ("integration_id") REFERENCES "attendance_integrations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- triggered_by is a raw user id with no FK, mirroring
-- attendance_corrections.approver_id: run history must survive the deletion of
-- the admin who triggered it.
