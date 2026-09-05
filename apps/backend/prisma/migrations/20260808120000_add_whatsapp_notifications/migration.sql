-- WhatsApp notifications (Evolution API) — Phase 1
--
-- Two new tables. Everything is IF NOT EXISTS because docker-entrypoint.sh runs
-- `prisma db push` on every container start, so a deployed environment may
-- already have these objects materialised from schema.prisma before this file
-- is applied. Both are CREATE TABLE on empty tables, so every index is a plain
-- CREATE INDEX and the whole file is transaction-safe (no CONCURRENTLY, no
-- ALTER TYPE ... ADD VALUE).
--
-- Notification.type is a free-text VarChar(50), so the new notification types
-- this feature introduces need no enum migration.

-- =====================================================================
-- whatsapp_identities — delivery identity + consent
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_identities" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"         UUID         NOT NULL,
    "employee_id"     UUID,
    "branch_id"       UUID,
    "phone_e164"      VARCHAR(20)  NOT NULL,
    "wa_jid"          VARCHAR(60),
    "source"          VARCHAR(20)  NOT NULL DEFAULT 'EMPLOYEE_PHONE',
    "opted_in"        BOOLEAN      NOT NULL DEFAULT false,
    "opted_in_at"     TIMESTAMP(6),
    "opted_out_at"    TIMESTAMP(6),
    "verified"        BOOLEAN      NOT NULL DEFAULT false,
    "verified_at"     TIMESTAMP(6),
    "last_checked_at" TIMESTAMP(6),
    "failure_count"   INTEGER      NOT NULL DEFAULT 0,
    "last_error"      TEXT,
    "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_identities_pkey" PRIMARY KEY ("id")
);

-- One WhatsApp number belongs to exactly one user. Enforced from day one so the
-- Phase 2 rule (a shared handset cannot hold durable auth to two payslips)
-- needs no index churn later.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_identities_phone_e164_key"
    ON "whatsapp_identities" ("phone_e164");

CREATE INDEX IF NOT EXISTS "whatsapp_identities_user_id_idx"
    ON "whatsapp_identities" ("user_id");
CREATE INDEX IF NOT EXISTS "whatsapp_identities_employee_id_idx"
    ON "whatsapp_identities" ("employee_id");
CREATE INDEX IF NOT EXISTS "whatsapp_identities_opted_in_verified_idx"
    ON "whatsapp_identities" ("opted_in", "verified");
CREATE INDEX IF NOT EXISTS "whatsapp_identities_branch_id_idx"
    ON "whatsapp_identities" ("branch_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_identities_user_id_fkey'
    ) THEN
        ALTER TABLE "whatsapp_identities"
            ADD CONSTRAINT "whatsapp_identities_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- =====================================================================
-- whatsapp_messages — the durable outbox
--
-- No FK to users or employees: the delivery log must survive employee deletion.
-- A cascade would erase the evidence that a message was sent.
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "dedupe_key"          VARCHAR(200) NOT NULL,
    "user_id"             UUID,
    "employee_id"         UUID,
    "branch_id"           UUID,
    "to_phone_e164"       VARCHAR(20)  NOT NULL,
    "template_key"        VARCHAR(60)  NOT NULL,
    "notification_type"   VARCHAR(50),
    "body"                TEXT         NOT NULL,
    "media_ref"           TEXT,
    "media_mime_type"     VARCHAR(100),
    "media_file_name"     VARCHAR(255),
    "status"              VARCHAR(20)  NOT NULL DEFAULT 'QUEUED',
    "attempts"            INTEGER      NOT NULL DEFAULT 0,
    "max_attempts"        INTEGER      NOT NULL DEFAULT 5,
    "next_attempt_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at"           TIMESTAMP(6),
    "sent_at"             TIMESTAMP(6),
    "provider_message_id" VARCHAR(120),
    "last_error"          TEXT,
    "created_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- Idempotency: enqueue is createMany(skipDuplicates), so a replayed cron or a
-- double-submit inserts zero rows rather than double-messaging a human.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_dedupe_key_key"
    ON "whatsapp_messages" ("dedupe_key");

-- Drives the drainer's claim scan.
CREATE INDEX IF NOT EXISTS "whatsapp_messages_status_next_attempt_at_idx"
    ON "whatsapp_messages" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_employee_id_created_at_idx"
    ON "whatsapp_messages" ("employee_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "whatsapp_messages_user_id_created_at_idx"
    ON "whatsapp_messages" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "whatsapp_messages_created_at_idx"
    ON "whatsapp_messages" ("created_at" DESC);
