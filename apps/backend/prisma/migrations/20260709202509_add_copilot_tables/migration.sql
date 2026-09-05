-- CreateTable
CREATE TABLE "copilot_conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "title" VARCHAR(255),
    "branch_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT,
    "tool_calls" JSONB,
    "tool_call_id" VARCHAR(100),
    "tool_name" VARCHAR(150),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copilot_pending_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "tool_call_id" VARCHAR(100) NOT NULL,
    "tool_name" VARCHAR(150) NOT NULL,
    "args_json" JSONB NOT NULL,
    "preview_json" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "result_json" JSONB,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "resolved_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_conversations_user_id_updated_at_idx" ON "copilot_conversations"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "copilot_messages_conversation_id_created_at_idx" ON "copilot_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "copilot_pending_actions_conversation_id_status_idx" ON "copilot_pending_actions"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "copilot_pending_actions_status_expires_at_idx" ON "copilot_pending_actions"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "copilot_conversations" ADD CONSTRAINT "copilot_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_messages" ADD CONSTRAINT "copilot_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copilot_pending_actions" ADD CONSTRAINT "copilot_pending_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "copilot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

