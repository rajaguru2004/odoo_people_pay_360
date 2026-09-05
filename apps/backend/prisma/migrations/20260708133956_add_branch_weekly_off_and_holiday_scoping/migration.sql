-- Per-branch weekly-off + branch-scoped holidays master
-- (hand-authored: `prisma migrate dev` shadow-replay is broken on a pre-existing migration)

-- AlterTable: Branch gets per-branch weekly off days (null => inherit global calendar_weekly_holidays)
ALTER TABLE "branches" ADD COLUMN "weekly_off_days" VARCHAR(20);

-- AlterTable: Holiday gets branch scoping + description + updatedAt
ALTER TABLE "holidays" ADD COLUMN "branch_id" UUID;
ALTER TABLE "holidays" ADD COLUMN "description" TEXT;
ALTER TABLE "holidays" ADD COLUMN "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Replace the global-only unique(date) with two partial unique indexes:
--   * at most one company-wide holiday per date (branch_id IS NULL)
--   * at most one holiday per date per branch (branch_id IS NOT NULL)
DROP INDEX IF EXISTS "holidays_date_key";
CREATE UNIQUE INDEX "holidays_date_global_uq" ON "holidays" ("date") WHERE "branch_id" IS NULL;
CREATE UNIQUE INDEX "holidays_date_branch_uq" ON "holidays" ("date", "branch_id") WHERE "branch_id" IS NOT NULL;

-- Lookup indexes
CREATE INDEX "holidays_year_idx" ON "holidays" ("year");
CREATE INDEX "holidays_branch_id_idx" ON "holidays" ("branch_id");

-- FK: holiday -> branch (branch-specific holidays are removed with their branch)
ALTER TABLE "holidays"
  ADD CONSTRAINT "holidays_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
