-- Employee Profile Template: admin-configurable employee form.
--
-- Purely ADDITIVE. Three new tables, one new nullable column on employees, and
-- a kill-switch defaulted OFF. No existing column is altered or dropped, so with
-- employee_template_enabled='false' the application behaves exactly as before
-- and rollback is a settings flip, not a migration.
--
-- Idempotent (IF NOT EXISTS) so it is safe on instances already updated via
-- `prisma db push` — docker-entrypoint.sh runs db push on every container start,
-- so this file must tolerate the tables already existing.

-- ── Templates ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "profile_templates" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "scope"      VARCHAR(10)  NOT NULL,
  "branch_id"  UUID,
  "country"    VARCHAR(2),
  "name"       VARCHAR(150) NOT NULL,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "profile_template_sections" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "template_id"   UUID         NOT NULL,
  "section_key"   VARCHAR(50)  NOT NULL,
  "label"         VARCHAR(150) NOT NULL,
  "icon"          VARCHAR(50),
  "wizard_step"   INTEGER      NOT NULL DEFAULT 1,
  "columns"       INTEGER      NOT NULL DEFAULT 2,
  "display_order" INTEGER      NOT NULL DEFAULT 0,
  "is_active"     BOOLEAN      NOT NULL DEFAULT true,
  "visible_to_roles" TEXT[]    NOT NULL DEFAULT '{}',
  "origin"        VARCHAR(10)  NOT NULL DEFAULT 'SYSTEM',
  "is_customized" BOOLEAN      NOT NULL DEFAULT false,
  "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_template_sections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "profile_template_fields" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "template_id"     UUID         NOT NULL,
  "section_id"      UUID         NOT NULL,
  "field_key"       VARCHAR(60)  NOT NULL,
  "label"           VARCHAR(150) NOT NULL,
  "field_type"      VARCHAR(25)  NOT NULL DEFAULT 'TEXT',
  "storage"         VARCHAR(10)  NOT NULL DEFAULT 'JSONB',
  "bound_column"    VARCHAR(80),
  "validation_type" VARCHAR(25)  NOT NULL DEFAULT 'NONE',
  "regex"           TEXT,
  "min_value"       DECIMAL(18,4),
  "max_value"       DECIMAL(18,4),
  "min_length"      INTEGER,
  "max_length"      INTEGER,
  "required"        BOOLEAN      NOT NULL DEFAULT false,
  "options"         JSONB,
  "option_source"   VARCHAR(40),
  "placeholder"     VARCHAR(255),
  "help_text"       VARCHAR(500),
  "default_value"   TEXT,
  "col_span"        INTEGER      NOT NULL DEFAULT 1,
  "display_order"   INTEGER      NOT NULL DEFAULT 0,
  "visible_to_roles"  TEXT[]     NOT NULL DEFAULT '{}',
  "editable_by_roles" TEXT[]     NOT NULL DEFAULT '{}',
  "self_visible"    BOOLEAN      NOT NULL DEFAULT true,
  "self_editable"   BOOLEAN      NOT NULL DEFAULT false,
  "is_sensitive"    BOOLEAN      NOT NULL DEFAULT false,
  "is_active"       BOOLEAN      NOT NULL DEFAULT true,
  "include_in_completion" BOOLEAN NOT NULL DEFAULT false,
  "origin"            VARCHAR(10) NOT NULL DEFAULT 'SYSTEM',
  "system_revision"   INTEGER     NOT NULL DEFAULT 1,
  "is_customized"     BOOLEAN     NOT NULL DEFAULT false,
  "system_deprecated" BOOLEAN     NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_template_fields_pkey" PRIMARY KEY ("id")
);

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by a catalog check.
DO $$ BEGIN
  ALTER TABLE "profile_templates"
    ADD CONSTRAINT "profile_templates_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "profile_template_sections"
    ADD CONSTRAINT "profile_template_sections_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "profile_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "profile_template_fields"
    ADD CONSTRAINT "profile_template_fields_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "profile_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "profile_template_fields"
    ADD CONSTRAINT "profile_template_fields_section_id_fkey"
    FOREIGN KEY ("section_id") REFERENCES "profile_template_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "profile_templates_scope_is_active_idx"
  ON "profile_templates" ("scope", "is_active");
CREATE INDEX IF NOT EXISTS "profile_templates_branch_id_is_active_idx"
  ON "profile_templates" ("branch_id", "is_active");

CREATE UNIQUE INDEX IF NOT EXISTS "profile_template_sections_template_id_section_key_key"
  ON "profile_template_sections" ("template_id", "section_key");
CREATE INDEX IF NOT EXISTS "profile_template_sections_template_id_display_order_idx"
  ON "profile_template_sections" ("template_id", "display_order");

CREATE UNIQUE INDEX IF NOT EXISTS "profile_template_fields_template_id_field_key_key"
  ON "profile_template_fields" ("template_id", "field_key");
CREATE INDEX IF NOT EXISTS "profile_template_fields_template_id_is_active_idx"
  ON "profile_template_fields" ("template_id", "is_active");
CREATE INDEX IF NOT EXISTS "profile_template_fields_section_id_display_order_idx"
  ON "profile_template_fields" ("section_id", "display_order");

-- Partial uniques: the resolution chain depends on "at most one active template
-- per scope". Prisma cannot express a WHERE clause on an index, so these exist
-- only here — noted inline in schema.prisma so they are not lost to a db push.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_company"
  ON "profile_templates" ((true))
  WHERE "scope" = 'COMPANY' AND "is_active";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_profile_template_branch"
  ON "profile_templates" ("branch_id")
  WHERE "scope" = 'BRANCH' AND "is_active" AND "branch_id" IS NOT NULL;

-- ── Employee value storage ──────────────────────────────────────────────────
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "custom_fields" JSONB;

-- Containment queries on the bag stay indexed even though v1 does not filter on
-- it; adding the index later on a populated table is the expensive path.
CREATE INDEX IF NOT EXISTS "employees_custom_fields_gin_idx"
  ON "employees" USING GIN ("custom_fields");

-- ── Kill switch ─────────────────────────────────────────────────────────────
-- OFF by default: the employee forms keep rendering their hardcoded fields and
-- `customFields` on the API is rejected until an admin opts in.
INSERT INTO "system_settings" ("key", "value")
VALUES ('employee_template_enabled', 'false')
ON CONFLICT ("key") DO NOTHING;
