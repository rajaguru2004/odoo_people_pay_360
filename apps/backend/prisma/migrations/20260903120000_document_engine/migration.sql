-- Dynamic document engine — one renderer, one template model, for every PDF
-- the portal emits.
--
-- WHY, since the tables read as a lot of machinery for "make a PDF": the
-- product had exactly ONE PDF generator (letters), whose templates were four
-- mutable rows with no versioning, no branch scope and no letterhead. A
-- salary certificate issued last March cannot today be shown to have come
-- from any particular wording, because the row it rendered from has been
-- edited since and kept no history. Every table below exists to make that
-- question answerable: DocumentTemplate is stable identity, versions are
-- immutable once published, and every generated file pins the version it came
-- from with ON DELETE RESTRICT so the pin cannot be broken.
--
-- Nothing here is reachable until `document_engine_enabled` is turned on; it
-- defaults to 'false'. Applying this to DEV or PROD is the user's call — it is
-- left PENDING in docs/DOCUMENT-PDF-ENGINE-TRACKER.md.
--
-- Apply with:
--   bash apps/backend/scripts/apply-migration.sh 20260903120000_document_engine "$DBURL"
--   npx prisma generate

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type_key" VARCHAR(50) NOT NULL,
    "locale" VARCHAR(5) NOT NULL DEFAULT 'en',
    "scope" VARCHAR(10) NOT NULL,
    "branch_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "published_version_id" UUID,
    "origin" VARCHAR(10) NOT NULL DEFAULT 'SYSTEM',
    "is_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "doc_json" JSONB,
    "body_html" TEXT NOT NULL,
    "style_css" TEXT,
    "footer_html" TEXT,
    "page_format" VARCHAR(10) NOT NULL DEFAULT 'A4',
    "orientation" VARCHAR(10) NOT NULL DEFAULT 'PORTRAIT',
    "margins_mm" JSONB,
    "letterhead_id" UUID,
    "content_hash" VARCHAR(64) NOT NULL,
    "change_note" TEXT,
    "created_by_id" UUID,
    "published_by_id" UUID,
    "published_at" TIMESTAMP(6),
    "archived_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" VARCHAR(20) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "scope" VARCHAR(10) NOT NULL,
    "branch_id" UUID,
    "private_ref" TEXT NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "cont_private_ref" TEXT,
    "cont_content_hash" VARCHAR(64),
    "safe_top_mm" DECIMAL(6,2) NOT NULL DEFAULT 35,
    "safe_right_mm" DECIMAL(6,2) NOT NULL DEFAULT 18,
    "safe_bottom_mm" DECIMAL(6,2) NOT NULL DEFAULT 25,
    "safe_left_mm" DECIMAL(6,2) NOT NULL DEFAULT 18,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_signatories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" VARCHAR(10) NOT NULL,
    "branch_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "slot_key" VARCHAR(40) NOT NULL,
    "signature_asset_id" UUID,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_signatories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "generated_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type_key" VARCHAR(50) NOT NULL,
    "locale" VARCHAR(5) NOT NULL DEFAULT 'en',
    "branch_id" UUID NOT NULL,
    "template_version_id" UUID,
    "template_content_hash" VARCHAR(64),
    "employee_id" UUID,
    "subject_type" VARCHAR(40),
    "subject_id" UUID,
    "params" JSONB,
    "serial_number" VARCHAR(50),
    "private_ref" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "page_count" INTEGER,
    "employee_document_id" UUID,
    "batch_id" UUID,
    "generated_by_id" UUID NOT NULL,
    "generated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type_key" VARCHAR(50) NOT NULL,
    "locale" VARCHAR(5) NOT NULL DEFAULT 'en',
    "branch_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "status" VARCHAR(25) NOT NULL DEFAULT 'QUEUED',
    "delivery_mode" VARCHAR(15) NOT NULL DEFAULT 'INDIVIDUAL',
    "params" JSONB,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "done_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "result_ref" TEXT,
    "result_file_name" VARCHAR(255),
    "claimed_at" TIMESTAMP(6),
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "last_error" TEXT,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_batch_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "employee_id" UUID,
    "subject_id" UUID,
    "status" VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "generated_document_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_published_version_id_key" ON "document_templates"("published_version_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_templates_type_key_locale_is_active_idx" ON "document_templates"("type_key", "locale", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_templates_scope_is_active_idx" ON "document_templates"("scope", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_templates_branch_id_is_active_idx" ON "document_templates"("branch_id", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_template_versions_template_id_status_idx" ON "document_template_versions"("template_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_template_id_version_no_key" ON "document_template_versions"("template_id", "version_no");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_assets_kind_is_active_idx" ON "document_assets"("kind", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_assets_scope_is_active_idx" ON "document_assets"("scope", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_assets_branch_id_is_active_idx" ON "document_assets"("branch_id", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_signatories_scope_is_active_idx" ON "document_signatories"("scope", "is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_signatories_branch_id_is_active_idx" ON "document_signatories"("branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "document_signatories_slot_key_branch_id_key" ON "document_signatories"("slot_key", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "generated_documents_serial_number_key" ON "generated_documents"("serial_number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generated_documents_type_key_generated_at_idx" ON "generated_documents"("type_key", "generated_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generated_documents_employee_id_type_key_idx" ON "generated_documents"("employee_id", "type_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generated_documents_branch_id_generated_at_idx" ON "generated_documents"("branch_id", "generated_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "generated_documents_batch_id_idx" ON "generated_documents"("batch_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_batches_status_created_at_idx" ON "document_batches"("status", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_batches_branch_id_created_at_idx" ON "document_batches"("branch_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_batch_items_batch_id_status_idx" ON "document_batch_items"("batch_id", "status");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_templates_branch_id_fkey') THEN
    ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_templates_published_version_id_fkey') THEN
    ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_published_version_id_fkey" FOREIGN KEY ("published_version_id") REFERENCES "document_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_template_versions_template_id_fkey') THEN
    ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_template_versions_letterhead_id_fkey') THEN
    ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_letterhead_id_fkey" FOREIGN KEY ("letterhead_id") REFERENCES "document_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_template_versions_created_by_id_fkey') THEN
    ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_template_versions_published_by_id_fkey') THEN
    ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_assets_branch_id_fkey') THEN
    ALTER TABLE "document_assets" ADD CONSTRAINT "document_assets_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_assets_created_by_id_fkey') THEN
    ALTER TABLE "document_assets" ADD CONSTRAINT "document_assets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_signatories_branch_id_fkey') THEN
    ALTER TABLE "document_signatories" ADD CONSTRAINT "document_signatories_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_signatories_signature_asset_id_fkey') THEN
    ALTER TABLE "document_signatories" ADD CONSTRAINT "document_signatories_signature_asset_id_fkey" FOREIGN KEY ("signature_asset_id") REFERENCES "document_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_branch_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_template_version_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "document_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_employee_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_employee_document_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_employee_document_id_fkey" FOREIGN KEY ("employee_document_id") REFERENCES "employee_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_batch_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "document_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_documents_generated_by_id_fkey') THEN
    ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_generated_by_id_fkey" FOREIGN KEY ("generated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_batches_branch_id_fkey') THEN
    ALTER TABLE "document_batches" ADD CONSTRAINT "document_batches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_batches_requested_by_id_fkey') THEN
    ALTER TABLE "document_batches" ADD CONSTRAINT "document_batches_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_batch_items_batch_id_fkey') THEN
    ALTER TABLE "document_batch_items" ADD CONSTRAINT "document_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "document_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_batch_items_employee_id_fkey') THEN
    ALTER TABLE "document_batch_items" ADD CONSTRAINT "document_batch_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;


-- Per-branch identity printed on generated documents. Nullable throughout: NULL
-- means "inherit the company-wide setting", the convention Branch already uses
-- for timezone and office hours. A branch that has its own commercial
-- registration prints it; one that does not falls back, and neither case needs
-- a separate template.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "phone" VARCHAR(50);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "email" VARCHAR(150);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "cr_number" VARCHAR(50);
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "vat_number" VARCHAR(50);

-- ---------------------------------------------------------------------------
-- Constraints Prisma's schema language cannot express.
--
-- These MUST also live in prisma/db-push-preflight.sql and
-- prisma/e2e-partial-indexes.sql: there are three provisioning paths (this
-- migration, `prisma db push` on container start, and the e2e template
-- database), and DDL present in only one of them produces an environment that
-- behaves differently from the others.
-- ---------------------------------------------------------------------------

-- THE CONCURRENCY RULE. At most one DRAFT and at most one PUBLISHED version
-- per template, enforced by the database rather than by a check-then-write in
-- a service method. Two admins pressing Publish at the same moment must have
-- one of them fail, and a service-level guard cannot promise that.
CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_published"
  ON "document_template_versions" ("template_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX IF NOT EXISTS "document_template_versions_one_draft"
  ON "document_template_versions" ("template_id") WHERE "status" = 'DRAFT';

-- One active template per (type, locale) per branch, plus one company-wide
-- fallback. Split into two indexes because NULL never equals NULL in a unique
-- index, so a single index over (type_key, locale, branch_id) would permit any
-- number of duplicate COMPANY rows. Same pattern as ledger_mappings.
CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_branch_key"
  ON "document_templates" ("type_key", "locale", "branch_id")
  WHERE "branch_id" IS NOT NULL AND "is_active" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "document_templates_company_key"
  ON "document_templates" ("type_key", "locale")
  WHERE "branch_id" IS NULL AND "is_active" = true;

-- Serials for engine-generated documents. `prisma db push` cannot create a
-- bare sequence, which is why this is also in the preflight file — the same
-- reason loan_reference_seq is there. letter_serial_seq is deliberately left
-- alone so letter serials stay continuous across the migration to the engine.
CREATE SEQUENCE IF NOT EXISTS "document_serial_seq" START WITH 1 INCREMENT BY 1;
