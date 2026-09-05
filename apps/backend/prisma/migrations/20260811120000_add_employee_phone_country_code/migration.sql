-- Per-employee country for reading `employees.phone` when it was typed without
-- a country prefix, so one instance can message a workforce spread over several
-- countries.
--
-- Deliberately nullable with no default and no backfill: NULL means "not
-- stated", which falls back to the branch country, then whatsapp.defaultRegion,
-- then payroll_country. Stamping every existing row with one country would turn
-- "we don't know" into a confident wrong answer, and a national number parsed
-- against the wrong country plausibly lands on a real stranger.
--
-- IF NOT EXISTS because docker-entrypoint.sh runs `prisma db push` on boot.
ALTER TABLE "employees"
    ADD COLUMN IF NOT EXISTS "phone_country_code" VARCHAR(2);
