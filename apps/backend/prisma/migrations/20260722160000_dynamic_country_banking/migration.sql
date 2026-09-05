-- Dynamic, country-aware banking configuration.
-- Follow-up to 20260722120000_add_bank_master_and_change_requests.
-- Idempotent (IF NOT EXISTS) so it is safe on instances already updated via db push.

-- Per-branch allowed banking countries (ISO-2). Empty => fall back to `country`.
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "banking_countries" TEXT[] NOT NULL DEFAULT '{}';

-- Dynamic field-value maps become the source of truth; legacy scalar columns kept nullable.
ALTER TABLE "employee_bank_details" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "employee_bank_details" ALTER COLUMN "iban" DROP NOT NULL;
ALTER TABLE "employee_bank_details" ALTER COLUMN "account_holder_name" DROP NOT NULL;

ALTER TABLE "bank_change_requests" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "bank_change_requests" ALTER COLUMN "iban" DROP NOT NULL;
ALTER TABLE "bank_change_requests" ALTER COLUMN "account_holder_name" DROP NOT NULL;

-- Configurable per-country banking field schema.
CREATE TABLE IF NOT EXISTS "country_banking_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "country" VARCHAR(2) NOT NULL,
    "field_key" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "field_type" VARCHAR(20) NOT NULL DEFAULT 'TEXT',
    "validation_type" VARCHAR(20) NOT NULL DEFAULT 'NONE',
    "regex" TEXT,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "placeholder" VARCHAR(255),
    "help_text" VARCHAR(255),
    "is_sensitive" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "country_banking_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "country_banking_fields_country_field_key_key" ON "country_banking_fields"("country", "field_key");
CREATE INDEX IF NOT EXISTS "country_banking_fields_country_is_active_idx" ON "country_banking_fields"("country", "is_active");
