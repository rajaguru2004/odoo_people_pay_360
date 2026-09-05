-- Single-use browser capability for a geofenced Discord check-in.
-- Discord has no location primitive, so the bot hands out a link and this row
-- is what the link carries.

-- CreateTable
CREATE TABLE "discord_action_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" VARCHAR(64) NOT NULL,
    "identity_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(40) NOT NULL DEFAULT 'CHECKIN',
    "action_key" VARCHAR(80) NOT NULL,
    "tool_name" VARCHAR(150) NOT NULL,
    "args_json" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(6) NOT NULL,
    "consumed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_action_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discord_action_tokens_token_hash_key" ON "discord_action_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "discord_action_tokens_user_id_purpose_status_idx" ON "discord_action_tokens"("user_id", "purpose", "status");

-- CreateIndex
CREATE INDEX "discord_action_tokens_status_expires_at_idx" ON "discord_action_tokens"("status", "expires_at");
