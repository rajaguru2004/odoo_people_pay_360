-- Tiered expiry reminders.
--
-- Replaces the two copy-pasted expiry crons (visa, contract), each of which
-- deduped on a single nullable `expiry_alert_sent_at` column and could
-- therefore alert exactly once per record, ever. The new engine fires at
-- configurable tiers (default 90/60/30/7) and dedupes per (source, entity,
-- tier, expiry).
--
-- `expiry_date` is part of the identity deliberately: renewing a record moves
-- its expiry, which legitimately re-arms every tier without deleting history.

CREATE TABLE IF NOT EXISTS "reminder_dispatches" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "source_key"  VARCHAR(50)  NOT NULL,
    "entity_id"   UUID         NOT NULL,
    "threshold"   INTEGER      NOT NULL,
    "expiry_date" DATE         NOT NULL,
    "sent_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_dispatches_pkey" PRIMARY KEY ("id")
);

-- The dedupe guarantee AND the concurrency guard: two overlapping cron runs
-- cannot both claim the same tier.
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_dispatches_source_entity_threshold_expiry_key"
    ON "reminder_dispatches" ("source_key", "entity_id", "threshold", "expiry_date");

CREATE INDEX IF NOT EXISTS "reminder_dispatches_source_key_sent_at_idx"
    ON "reminder_dispatches" ("source_key", "sent_at");

-- ---------------------------------------------------------------------------
-- Backfill: do not re-alert records the legacy crons already covered.
--
-- A record with `expiry_alert_sent_at` set was alerted once, when it had
-- (expiry_date - expiry_alert_sent_at) days remaining. Every tier at or above
-- that figure is therefore already served and is inserted as dispatched; the
-- tighter tiers below it are left free to fire, which is the intended upgrade.
--
-- Tier list matches ReminderSource.defaultThresholds. If an admin narrows
-- `reminder_days_*`, the extra rows are simply never consulted.
-- ---------------------------------------------------------------------------

INSERT INTO "reminder_dispatches" ("source_key", "entity_id", "threshold", "expiry_date", "sent_at")
SELECT
    'legal_document',
    d."id",
    t."threshold",
    d."expiry_date",
    d."expiry_alert_sent_at"
FROM "employee_legal_documents" d
CROSS JOIN (VALUES (90), (60), (30), (7)) AS t("threshold")
WHERE d."expiry_alert_sent_at" IS NOT NULL
  AND d."expiry_date" IS NOT NULL
  AND t."threshold" >= (d."expiry_date" - d."expiry_alert_sent_at"::date)
ON CONFLICT DO NOTHING;

INSERT INTO "reminder_dispatches" ("source_key", "entity_id", "threshold", "expiry_date", "sent_at")
SELECT
    'contract',
    c."id",
    t."threshold",
    c."end_date",
    c."expiry_alert_sent_at"
FROM "contracts" c
CROSS JOIN (VALUES (90), (60), (30), (7)) AS t("threshold")
WHERE c."expiry_alert_sent_at" IS NOT NULL
  AND c."end_date" IS NOT NULL
  AND t."threshold" >= (c."end_date" - c."expiry_alert_sent_at"::date)
ON CONFLICT DO NOTHING;
