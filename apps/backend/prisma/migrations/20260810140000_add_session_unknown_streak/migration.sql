-- Consecutive unrouted messages per chat, so a run of confusion can escalate
-- instead of repeating the same three guesses forever.
--
-- IF NOT EXISTS because docker-entrypoint.sh runs `prisma db push` on boot.
ALTER TABLE "whatsapp_sessions"
    ADD COLUMN IF NOT EXISTS "unknown_streak" INTEGER NOT NULL DEFAULT 0;
