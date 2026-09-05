-- Asset register: `asset_tag` becomes unique PER BRANCH, and `status` becomes a
-- real Postgres enum.
--
-- ─── WHY: asset_tag (finding R2) ────────────────────────────────────────────
--
-- `asset_tag` was globally `@unique`, so two branches could not both hold
-- "LAP-001" — and branches genuinely do run their own numbering. The failure
-- was not merely inconvenient, it was UNRESOLVABLE for the person who hit it:
-- a branch-scoped HR registering their own "LAP-001" got a 409 quoting a tag
-- back at them, and the search that error invites returns nothing, because the
-- colliding row lives in a branch the Prisma branch middleware hides from them.
-- They are told the tag is taken and every tool they have says it is free.
--
-- ─── WHY: status (finding R15) ──────────────────────────────────────────────
--
-- `status` was `VARCHAR(20)` policed only by `@IsIn(ASSET_STATUSES)` in the
-- DTO. A DTO guards one door. Anything reaching the table by another route — a
-- seed, a backfill, an MCP tool, a future endpoint that forgets the constant —
-- was stored, served straight back out of `GET /assets/:id`, counted in
-- `/assets/summary` byStatus, and then UNREACHABLE: `?status=SCRAPPED` is
-- refused by the same DTO that refuses to create it, so the row cannot be
-- filtered for. The rule now lives in the database, where every writer meets it.
--
-- ─── ORDER ──────────────────────────────────────────────────────────────────
-- Data is reconciled BEFORE the DDL that depends on it, so a bad row produces a
-- named, actionable error instead of a raw Postgres cast failure.

-- ── 1. The enum type ────────────────────────────────────────────────────────
-- Prisma names the PG type after the Prisma enum verbatim: `AssetStatus`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssetStatus') THEN
    CREATE TYPE "AssetStatus" AS ENUM (
      'AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED'
    );
  END IF;
END
$$;

-- ── 2. Refuse loudly on an out-of-range status ──────────────────────────────
--
-- REFUSE, not map. An asset whose status is not one of the five is an asset in
-- an unknown state, and every available mapping is a guess with a cost:
-- AVAILABLE puts a possibly-lost or possibly-scrapped item back into the
-- assignable pool, RETIRED takes a live one out of it, and either way the
-- original value is destroyed and nobody can tell afterwards what it was. The
-- migration therefore stops and names the offenders, which is a five-minute
-- human decision made once, against a silent data rewrite discovered later.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_items'
       AND column_name = 'status'
       AND data_type = 'character varying'
  ) THEN
    RETURN;  -- already converted
  END IF;

  SELECT string_agg(format('%L (%s rows)', status, n), ', ')
    INTO offenders
    FROM (
      SELECT "status", COUNT(*) AS n
        FROM "asset_items"
       WHERE "status" NOT IN ('AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED')
       GROUP BY 1
       LIMIT 20
    ) d;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot convert asset_items.status to the AssetStatus enum: % rows hold a value outside AVAILABLE|ASSIGNED|IN_REPAIR|LOST|RETIRED. Decide what each one means and UPDATE it to one of the five before re-running — this migration will not guess, because guessing either returns a lost item to the assignable pool or retires a live one. Offenders: %',
      (SELECT COUNT(*) FROM "asset_items"
        WHERE "status" NOT IN ('AVAILABLE','ASSIGNED','IN_REPAIR','LOST','RETIRED')),
      offenders;
  END IF;
END
$$;

-- ── 3. Convert the column ───────────────────────────────────────────────────
-- A VarChar → enum change is not implicit: it needs an explicit USING cast, and
-- the DEFAULT must be dropped first (it is a VarChar literal, which cannot be
-- re-typed in place) and restored as an enum literal afterwards.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'asset_items'
       AND column_name = 'status'
       AND data_type = 'character varying'
  ) THEN
    ALTER TABLE "asset_items" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "asset_items"
      ALTER COLUMN "status" TYPE "AssetStatus" USING ("status"::"AssetStatus");
    ALTER TABLE "asset_items"
      ALTER COLUMN "status" SET DEFAULT 'AVAILABLE'::"AssetStatus";
  END IF;
END
$$;

-- ── 4. asset_tag: global unique → per-branch unique ─────────────────────────
--
-- The duplicate check below can only ever fire if the global unique has already
-- been dropped by hand — while it stands, a per-branch duplicate is impossible.
-- It is written anyway because this file must be safe on a database that has
-- been touched, not only on one that has not.
DO $$
DECLARE
  duplicate_sample TEXT;
BEGIN
  IF to_regclass('"asset_items_branch_id_asset_tag_key"') IS NOT NULL THEN
    RETURN;  -- already applied
  END IF;

  SELECT string_agg(format('branch=%s asset_tag=%s (%s rows)', branch_id, asset_tag, n), ', ')
    INTO duplicate_sample
    FROM (
      SELECT "branch_id", "asset_tag", COUNT(*) AS n
        FROM "asset_items"
       GROUP BY 1, 2
      HAVING COUNT(*) > 1
       LIMIT 10
    ) d;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create asset_items_branch_id_asset_tag_key: asset_tag is duplicated within a branch. Re-tag the duplicates and re-run. Offenders: %',
      duplicate_sample;
  END IF;

  -- The old global unique arrives as a CONSTRAINT on a migrate-built database
  -- and as a bare INDEX on a `db push`-built one. They share one namespace, so
  -- both spellings must be handled or the CREATE below dies on the name it did
  -- not drop.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"asset_items"'::regclass
       AND conname = 'asset_items_asset_tag_key'
  ) THEN
    ALTER TABLE "asset_items" DROP CONSTRAINT "asset_items_asset_tag_key";
  ELSE
    DROP INDEX IF EXISTS "asset_items_asset_tag_key";
  END IF;

  CREATE UNIQUE INDEX "asset_items_branch_id_asset_tag_key"
    ON "asset_items" ("branch_id", "asset_tag");
END
$$;
