-- Conduct date indexes, for the Talent hub aggregate.
--
-- WHY
-- `rewards` and `disciplines` each carried exactly one index, on `employee_id`.
-- That is the right index for "show me this person's record", which is the only
-- question either table was asked before Phase G: `RewardsService.findAll` and
-- `DisciplinesService.findAll` take an `employeeId` and a page, and no date
-- range at all.
--
-- `GET /talent/hub-summary` asks two new questions, both keyed on the business
-- date rather than the employee:
--   • how many rewards / disciplinary actions fall in this calendar month, and
--     in the one before it (the KPI and its delta); and
--   • how many fall in each of the trailing twelve months (the hub's headline
--     chart).
--
-- Without these indexes every one of those is a sequential scan of the whole
-- table. It is cheap today on a demo database and stops being cheap on a
-- tenant with years of history — which is exactly when a dashboard is expected
-- to stay fast.
--
-- Both indexes are expressible in `schema.prisma` (`@@index([rewardDate])` and
-- `@@index([disciplineDate])`), so unlike a bare sequence or a partial index
-- there is nothing to mirror into `prisma/db-push-preflight.sql` or
-- `prisma/e2e-partial-indexes.sql` — `prisma db push` creates them from the
-- schema on every provisioning path.
--
-- SAFETY
-- Additive and idempotent. No column is added, altered or dropped, and no row
-- is touched, so there is nothing to roll back beyond dropping the indexes.

CREATE INDEX IF NOT EXISTS "rewards_reward_date_idx" ON "rewards" ("reward_date");

CREATE INDEX IF NOT EXISTS "disciplines_discipline_date_idx" ON "disciplines" ("discipline_date");
