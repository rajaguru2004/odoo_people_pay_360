-- Channel-agnostic attendance verification: capability + proof receipt.
--
-- Everything is IF NOT EXISTS because docker-entrypoint.sh runs `prisma db push`
-- on every container start, so a deployed environment may already have these
-- objects from schema.prisma. Plain CREATE INDEX only (no CONCURRENTLY) and no
-- ALTER TYPE, so the whole file stays transaction-safe under `db execute`.

CREATE TABLE IF NOT EXISTS "channel_verification_tokens" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "token_hash"       VARCHAR(64)  NOT NULL,
    "channel"          VARCHAR(20)  NOT NULL,
    "delivery_mode"    VARCHAR(10)  NOT NULL DEFAULT 'LINK',
    "identity_id"      UUID         NOT NULL,
    "user_id"          UUID         NOT NULL,
    "employee_id"      UUID,
    "purpose"          VARCHAR(20)  NOT NULL DEFAULT 'CHECKIN',
    "require_location" BOOLEAN      NOT NULL DEFAULT false,
    "require_face"     BOOLEAN      NOT NULL DEFAULT false,
    "action_key"       VARCHAR(80)  NOT NULL,
    "tool_name"        VARCHAR(150) NOT NULL,
    "args_json"        JSONB        NOT NULL,
    "status"           VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    "attempts"         INTEGER      NOT NULL DEFAULT 0,
    "max_attempts"     INTEGER      NOT NULL DEFAULT 5,
    "expires_at"       TIMESTAMP(6) NOT NULL,
    "consumed_at"      TIMESTAMP(6),
    "face_verified_at" TIMESTAMP(6),
    "face_distance"    DOUBLE PRECISION,
    "face_quality"     DOUBLE PRECISION,
    "face_image_url"   TEXT,
    "image_sha256"     VARCHAR(64),
    "proof_spent_at"   TIMESTAMP(6),
    "created_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_verification_tokens_token_hash_key"
    ON "channel_verification_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "channel_verification_tokens_user_id_purpose_status_idx"
    ON "channel_verification_tokens" ("user_id", "purpose", "status");
CREATE INDEX IF NOT EXISTS "channel_verification_tokens_channel_identity_status_idx"
    ON "channel_verification_tokens" ("channel", "identity_id", "status");
CREATE INDEX IF NOT EXISTS "channel_verification_tokens_status_expires_at_idx"
    ON "channel_verification_tokens" ("status", "expires_at");
CREATE INDEX IF NOT EXISTS "channel_verification_tokens_employee_id_created_at_idx"
    ON "channel_verification_tokens" ("employee_id", "created_at" DESC);

-- Carry LIVE Discord check-in links forward. A /attendance-checkin issued sixty
-- seconds before this deploy must not 404 when the employee taps it.
--
-- Bare ON CONFLICT DO NOTHING (no arbiter) so both the primary key and the
-- token_hash unique index are covered, and a re-run is a no-op.
INSERT INTO "channel_verification_tokens" (
    "id", "token_hash", "channel", "delivery_mode", "identity_id", "user_id",
    "purpose", "require_location", "require_face",
    "action_key", "tool_name", "args_json",
    "status", "expires_at", "consumed_at", "created_at"
)
SELECT d."id", d."token_hash", 'discord', 'LINK', d."identity_id", d."user_id",
       'CHECKIN', true, false,
       d."action_key", d."tool_name", d."args_json",
       d."status", d."expires_at", d."consumed_at", d."created_at"
FROM "discord_action_tokens" d
WHERE d."status" = 'PENDING' AND d."expires_at" > CURRENT_TIMESTAMP
ON CONFLICT DO NOTHING;

-- Policy back-fill.
--
-- The code default for the new enum is OFF, because OFF is what an untouched
-- install actually ENFORCED: the settings service defaulted the old boolean to
-- true while AttendancesService defaulted it to false, so the admin toggle
-- rendered on and nothing was exempt.
--
-- Preserving intent is therefore a DATA migration rather than a code default.
-- An admin who deliberately switched the boolean on keeps exactly the behaviour
-- they chose; everybody else keeps exactly the behaviour they had; and nobody
-- is silently upgraded into a face requirement.
INSERT INTO "system_settings" ("key", "value")
SELECT 'whatsapp.attendanceVerification',
       CASE WHEN s."value" = 'true' THEN 'IDENTITY_ONLY' ELSE 'OFF' END
FROM "system_settings" s
WHERE s."key" = 'whatsapp.attendanceFaceOverride'
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "system_settings" ("key", "value")
SELECT 'discord.attendanceVerification',
       CASE WHEN s."value" = 'true' THEN 'IDENTITY_ONLY' ELSE 'OFF' END
FROM "system_settings" s
WHERE s."key" = 'discord.attendanceFaceOverride'
ON CONFLICT ("key") DO NOTHING;
