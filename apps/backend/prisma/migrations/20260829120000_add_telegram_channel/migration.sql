-- Telegram channel
--
-- Third delivery channel. Same shape as the Discord tables: an identity row is
-- authentication, an outbound row is the claim, the payload and the delivery
-- record. Everything is IF NOT EXISTS because docker-entrypoint.sh runs
-- `prisma db push` on every container start. All plain CREATE INDEX, so the
-- file is transaction-safe.

-- =====================================================================
-- telegram_identities — Telegram private chat -> ESS user
-- =====================================================================
CREATE TABLE IF NOT EXISTS "telegram_identities" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"          UUID         NOT NULL,
    "employee_id"      UUID,
    "branch_id"        UUID,
    "telegram_chat_id" VARCHAR(32)  NOT NULL,
    "telegram_user_id" VARCHAR(32),
    "username"         VARCHAR(64),
    "status"           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    "link_code_hash"   VARCHAR(255),
    "link_expires_at"  TIMESTAMP(6),
    "linked_at"        TIMESTAMP(6),
    "opted_in"         BOOLEAN      NOT NULL DEFAULT true,
    "opted_out_at"     TIMESTAMP(6),
    "last_seen_at"     TIMESTAMP(6),
    "revoked_at"       TIMESTAMP(6),
    "created_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_identities_pkey" PRIMARY KEY ("id")
);

-- One Telegram chat is one person — the same rule the other two channels apply.
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_identities_telegram_chat_id_key"
    ON "telegram_identities" ("telegram_chat_id");
CREATE INDEX IF NOT EXISTS "telegram_identities_user_id_idx"
    ON "telegram_identities" ("user_id");
CREATE INDEX IF NOT EXISTS "telegram_identities_employee_id_idx"
    ON "telegram_identities" ("employee_id");
CREATE INDEX IF NOT EXISTS "telegram_identities_status_idx"
    ON "telegram_identities" ("status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'telegram_identities_user_id_fkey'
    ) THEN
        ALTER TABLE "telegram_identities"
            ADD CONSTRAINT "telegram_identities_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- =====================================================================
-- telegram_messages — outbound message log
--
-- No FK to users/employees: the delivery log must survive employee deletion,
-- or it stops being evidence that a message was sent. `user_id` is nullable
-- because a login alert is addressed to a CHAT, and a FAILED login may not
-- correspond to any user row at all.
-- =====================================================================
CREATE TABLE IF NOT EXISTS "telegram_messages" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "dedupe_key"          VARCHAR(200) NOT NULL,
    "user_id"             UUID,
    "employee_id"         UUID,
    "branch_id"           UUID,
    "chat_id"             VARCHAR(32)  NOT NULL,
    "template_key"        VARCHAR(60)  NOT NULL,
    "notification_type"   VARCHAR(50),
    "body"                TEXT         NOT NULL,
    "status"              VARCHAR(20)  NOT NULL DEFAULT 'QUEUED',
    "attempts"            INTEGER      NOT NULL DEFAULT 0,
    "max_attempts"        INTEGER      NOT NULL DEFAULT 5,
    "next_attempt_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at"           TIMESTAMP(6),
    "sent_at"             TIMESTAMP(6),
    "provider_message_id" VARCHAR(64),
    "last_error"          TEXT,
    "created_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "telegram_messages_dedupe_key_key"
    ON "telegram_messages" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "telegram_messages_status_next_attempt_at_idx"
    ON "telegram_messages" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "telegram_messages_user_id_created_at_idx"
    ON "telegram_messages" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "telegram_messages_created_at_idx"
    ON "telegram_messages" ("created_at" DESC);
