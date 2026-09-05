-- Self-service letters, grievance handling, and the columns the document vault
-- and the reminder engine need on employee_documents.

ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'GRIEVANCE_CATEGORY';

-- ---------------------------------------------------------------------------
-- employee_documents: dates + provenance
--
-- There was previously no date on a personal document, so nothing here could
-- ever enter the expiry reminder engine. `private_ref` lets a generated letter
-- live in the private bucket while legacy uploads keep using file_url.
-- ---------------------------------------------------------------------------
ALTER TABLE "employee_documents"
    ADD COLUMN IF NOT EXISTS "issue_date"          DATE,
    ADD COLUMN IF NOT EXISTS "expiry_date"         DATE,
    ADD COLUMN IF NOT EXISTS "is_system_generated" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "private_ref"         TEXT;

CREATE INDEX IF NOT EXISTS "employee_documents_expiry_date_idx"
    ON "employee_documents" ("expiry_date");

-- ---------------------------------------------------------------------------
-- Self-service letters
--
-- Templates are DB rows, not filesystem .hbs files: HR rewords a letter without
-- a redeploy, and each letter needs an Arabic variant (the locale column).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "letter_templates" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "key"               VARCHAR(50)  NOT NULL,
    "name"              VARCHAR(200) NOT NULL,
    "locale"            VARCHAR(5)   NOT NULL DEFAULT 'en',
    "body_html"         TEXT         NOT NULL,
    "requires_approval" BOOLEAN      NOT NULL DEFAULT true,
    "is_active"         BOOLEAN      NOT NULL DEFAULT true,
    "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "letter_templates_key_locale_key"
    ON "letter_templates" ("key", "locale");

CREATE TABLE IF NOT EXISTS "letter_requests" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "employee_id"     UUID         NOT NULL,
    "template_key"    VARCHAR(50)  NOT NULL,
    "locale"          VARCHAR(5)   NOT NULL DEFAULT 'en',
    "purpose"         TEXT,
    "addressed_to"    VARCHAR(200),
    "status"          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    "serial_number"   VARCHAR(50),
    "file_ref"        TEXT,
    "document_id"     UUID,
    "issued_by_id"    UUID,
    "issued_at"       TIMESTAMP(6),
    "rejected_reason" TEXT,
    "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "letter_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "letter_requests_serial_number_key"
    ON "letter_requests" ("serial_number");
CREATE INDEX IF NOT EXISTS "letter_requests_employee_id_status_idx"
    ON "letter_requests" ("employee_id", "status");
CREATE INDEX IF NOT EXISTS "letter_requests_status_idx"
    ON "letter_requests" ("status");

-- Serial numbers are printed on the letter and used for verification, so they
-- must be gapless-ish and never collide under concurrency. A sequence is the
-- only thing that guarantees that; SELECT MAX(...)+1 does not.
CREATE SEQUENCE IF NOT EXISTS "letter_serial_seq" START 1;

-- ---------------------------------------------------------------------------
-- Grievances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "grievances" (
    "id"                   UUID         NOT NULL DEFAULT gen_random_uuid(),
    "employee_id"          UUID         NOT NULL,
    "category"             VARCHAR(100) NOT NULL,
    "subject"              VARCHAR(200) NOT NULL,
    "description"          TEXT         NOT NULL,
    "is_confidential"      BOOLEAN      NOT NULL DEFAULT false,
    "against_employee_id"  UUID,
    "status"               VARCHAR(20)  NOT NULL DEFAULT 'OPEN',
    "assigned_to_id"       UUID,
    "resolution"           TEXT,
    "resolved_at"          TIMESTAMP(6),
    "created_at"           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "grievances_employee_id_status_idx"
    ON "grievances" ("employee_id", "status");
CREATE INDEX IF NOT EXISTS "grievances_assigned_to_id_status_idx"
    ON "grievances" ("assigned_to_id", "status");
CREATE INDEX IF NOT EXISTS "grievances_status_idx" ON "grievances" ("status");

CREATE TABLE IF NOT EXISTS "grievance_events" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "grievance_id"  UUID         NOT NULL,
    "type"          VARCHAR(30)  NOT NULL,
    "from_status"   VARCHAR(20),
    "to_status"     VARCHAR(20),
    "note"          TEXT,
    "is_internal"   BOOLEAN      NOT NULL DEFAULT false,
    "actor_user_id" UUID,
    "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grievance_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "grievance_events_grievance_id_created_at_idx"
    ON "grievance_events" ("grievance_id", "created_at");

-- ── Foreign keys ────────────────────────────────────────────────────────────

DO $$
BEGIN
    ALTER TABLE "letter_requests" ADD CONSTRAINT "letter_requests_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "letter_requests" ADD CONSTRAINT "letter_requests_issued_by_id_fkey"
        FOREIGN KEY ("issued_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "grievances" ADD CONSTRAINT "grievances_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "grievances" ADD CONSTRAINT "grievances_against_employee_id_fkey"
        FOREIGN KEY ("against_employee_id") REFERENCES "employees"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "grievances" ADD CONSTRAINT "grievances_assigned_to_id_fkey"
        FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "grievance_events" ADD CONSTRAINT "grievance_events_grievance_id_fkey"
        FOREIGN KEY ("grievance_id") REFERENCES "grievances"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "grievance_events" ADD CONSTRAINT "grievance_events_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
