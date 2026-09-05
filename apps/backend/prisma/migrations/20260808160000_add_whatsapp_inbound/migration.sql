-- WhatsApp inbound / interactive ESS — Phase 2
--
-- Extends whatsapp_identities with the inbound trust columns, and adds the five
-- tables the conversational layer needs. Everything is IF NOT EXISTS because
-- docker-entrypoint.sh runs `prisma db push` on every container start, so a
-- deployed environment may already have these objects from schema.prisma.
--
-- All plain CREATE INDEX (no CONCURRENTLY) and no ALTER TYPE, so the whole file
-- is transaction-safe.

-- =====================================================================
-- whatsapp_identities — inbound trust columns
-- =====================================================================
ALTER TABLE "whatsapp_identities"
    ADD COLUMN IF NOT EXISTS "remote_jid"        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "status"            VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS "label"             VARCHAR(60),
    ADD COLUMN IF NOT EXISTS "pin_hash"          VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "pin_set_at"        TIMESTAMP(6),
    ADD COLUMN IF NOT EXISTS "failed_pin_count"  INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "locked_until"      TIMESTAMP(6),
    ADD COLUMN IF NOT EXISTS "handset_opt_in_at" TIMESTAMP(6),
    ADD COLUMN IF NOT EXISTS "last_seen_at"      TIMESTAMP(6),
    ADD COLUMN IF NOT EXISTS "daily_msg_count"   INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "daily_msg_date"    DATE,
    ADD COLUMN IF NOT EXISTS "created_by_id"     UUID,
    ADD COLUMN IF NOT EXISTS "revoked_at"        TIMESTAMP(6),
    ADD COLUMN IF NOT EXISTS "revoked_by_id"     UUID;

CREATE INDEX IF NOT EXISTS "whatsapp_identities_status_idx"
    ON "whatsapp_identities" ("status");

-- =====================================================================
-- whatsapp_enrollments — one-time codes proving handset control
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_enrollments" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"      UUID         NOT NULL,
    "phone_e164"   VARCHAR(20)  NOT NULL,
    "code_hash"    VARCHAR(255) NOT NULL,
    "expires_at"   TIMESTAMP(6) NOT NULL,
    "attempts"     INTEGER      NOT NULL DEFAULT 0,
    "max_attempts" INTEGER      NOT NULL DEFAULT 5,
    "consumed_at"  TIMESTAMP(6),
    "created_ip"   INET,
    "created_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "whatsapp_enrollments_user_id_created_at_idx"
    ON "whatsapp_enrollments" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "whatsapp_enrollments_phone_e164_created_at_idx"
    ON "whatsapp_enrollments" ("phone_e164", "created_at" DESC);

-- =====================================================================
-- whatsapp_sessions — conversation state (never authentication)
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_sessions" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "instance"        VARCHAR(100) NOT NULL,
    "remote_jid"      VARCHAR(100) NOT NULL,
    "identity_id"     UUID,
    "user_id"         UUID,
    "flow_key"        VARCHAR(80),
    "flow_step"       INTEGER,
    "slots_json"      JSONB,
    "flow_expires_at" TIMESTAMP(6),
    "flow_errors"     INTEGER      NOT NULL DEFAULT 0,
    "last_menu_json"  JSONB,
    "last_menu_at"    TIMESTAMP(6),
    "pin_verified_at" TIMESTAMP(6),
    "last_message_at" TIMESTAMP(6),
    "version"         INTEGER      NOT NULL DEFAULT 0,
    "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_sessions_instance_remote_jid_key"
    ON "whatsapp_sessions" ("instance", "remote_jid");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_flow_expires_at_idx"
    ON "whatsapp_sessions" ("flow_expires_at");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_idx"
    ON "whatsapp_sessions" ("user_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sessions_identity_id_fkey'
    ) THEN
        ALTER TABLE "whatsapp_sessions"
            ADD CONSTRAINT "whatsapp_sessions_identity_id_fkey"
            FOREIGN KEY ("identity_id") REFERENCES "whatsapp_identities"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- =====================================================================
-- whatsapp_inbound_messages — the duplicate-delivery claim and retry record
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_inbound_messages" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "instance"            VARCHAR(100) NOT NULL,
    "wa_message_id"       VARCHAR(120) NOT NULL,
    "remote_jid"          VARCHAR(100) NOT NULL,
    "phone_e164"          VARCHAR(20),
    "push_name"           VARCHAR(120),
    "session_id"          UUID,
    "identity_id"         UUID,
    "user_id"             UUID,
    "input_kind"          VARCHAR(20)  NOT NULL,
    "body"                TEXT,
    "callback_id"         VARCHAR(220),
    "resolved_action_key" VARCHAR(80),
    "status"              VARCHAR(20)  NOT NULL DEFAULT 'RECEIVED',
    "attempts"            INTEGER      NOT NULL DEFAULT 0,
    "last_error"          TEXT,
    "next_retry_at"       TIMESTAMP(6),
    "raw_json"            JSONB,
    "received_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"        TIMESTAMP(6),

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- The claim: a duplicate webhook delivery loses this insert instead of
-- re-running the action.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_inbound_messages_instance_wa_message_id_key"
    ON "whatsapp_inbound_messages" ("instance", "wa_message_id");
CREATE INDEX IF NOT EXISTS "whatsapp_inbound_messages_status_next_retry_at_idx"
    ON "whatsapp_inbound_messages" ("status", "next_retry_at");
CREATE INDEX IF NOT EXISTS "whatsapp_inbound_messages_user_id_received_at_idx"
    ON "whatsapp_inbound_messages" ("user_id", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "whatsapp_inbound_messages_received_at_idx"
    ON "whatsapp_inbound_messages" ("received_at" DESC);

-- =====================================================================
-- whatsapp_pending_actions — server-side args for a write awaiting "yes"
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_pending_actions" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "session_id"   UUID         NOT NULL,
    "user_id"      UUID         NOT NULL,
    "identity_id"  UUID         NOT NULL,
    "action_key"   VARCHAR(80)  NOT NULL,
    "tool_name"    VARCHAR(150) NOT NULL,
    "args_json"    JSONB        NOT NULL,
    "preview_json" JSONB,
    "status"       VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    "result_json"  JSONB,
    "expires_at"   TIMESTAMP(6) NOT NULL,
    "resolved_at"  TIMESTAMP(6),
    "created_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "whatsapp_pending_actions_session_id_status_idx"
    ON "whatsapp_pending_actions" ("session_id", "status");
CREATE INDEX IF NOT EXISTS "whatsapp_pending_actions_status_expires_at_idx"
    ON "whatsapp_pending_actions" ("status", "expires_at");

-- =====================================================================
-- whatsapp_action_tokens — single-use approve/reject capability
-- =====================================================================
CREATE TABLE IF NOT EXISTS "whatsapp_action_tokens" (
    "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
    "token_hash"             VARCHAR(64)  NOT NULL,
    "identity_id"            UUID         NOT NULL,
    "user_id"                UUID         NOT NULL,
    "action_key"             VARCHAR(80)  NOT NULL,
    "tool_name"              VARCHAR(150) NOT NULL,
    "args_json"              JSONB        NOT NULL,
    "resource_type"          VARCHAR(100) NOT NULL,
    "resource_id"            UUID         NOT NULL,
    "status"                 VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    "expires_at"             TIMESTAMP(6) NOT NULL,
    "consumed_at"            TIMESTAMP(6),
    "consumed_by_message_id" UUID,
    "created_at"             TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_action_tokens_pkey" PRIMARY KEY ("id")
);

-- Only the hash is stored, so the table cannot leak a usable token.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_action_tokens_token_hash_key"
    ON "whatsapp_action_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "whatsapp_action_tokens_lookup_idx"
    ON "whatsapp_action_tokens" ("user_id", "resource_type", "resource_id", "status");
CREATE INDEX IF NOT EXISTS "whatsapp_action_tokens_status_expires_at_idx"
    ON "whatsapp_action_tokens" ("status", "expires_at");
