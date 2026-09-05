-- Tappable affordances on an outbound message, decided at enqueue time.
--
-- IF NOT EXISTS because docker-entrypoint.sh runs `prisma db push` on every
-- container start, so a deployed environment may already have this column.
ALTER TABLE "whatsapp_messages"
    ADD COLUMN IF NOT EXISTS "interactive_json" JSONB;
