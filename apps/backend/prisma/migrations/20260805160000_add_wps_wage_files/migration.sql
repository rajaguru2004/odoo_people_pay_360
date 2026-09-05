-- Wage Protection System (WPS) — salary payment files.
--
-- The HRMS never moves money: it produces the official salary instruction file
-- the employer uploads to their bank, and the bank validates and transfers.
--
-- Four tables:
--   wps_employer_profiles  employer registration as the wage authority knows it,
--                          shared across branches (one MoL establishment can
--                          cover several offices), fields in JSONB because they
--                          differ per country.
--   wps_configurations     which format + employer a branch pays through. One row
--                          per branch (UNIQUE) so two generations cannot race.
--   wps_files              one generated file/file set. Immutable once GENERATED;
--                          a correction is a new row at version+1.
--   wps_file_rows          per-employee snapshot of what the file told the bank,
--                          so a per-row bank rejection has somewhere to live.
--
-- Status columns are VARCHAR, not enums: ALTER TYPE ... ADD VALUE cannot run in a
-- transaction, and bank acknowledgement vocabularies differ per country.

-- CreateTable
CREATE TABLE "wps_employer_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "format" VARCHAR(50) NOT NULL,
    "data" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wps_employer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wps_configurations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "employer_profile_id" UUID NOT NULL,
    "format" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_run_options" JSONB,
    "accepted_warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wps_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wps_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "branch_id" UUID NOT NULL,
    "payroll_id" UUID NOT NULL,
    "configuration_id" UUID,
    "format" VARCHAR(50) NOT NULL,
    "spec_version" VARCHAR(100) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'GENERATING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "previous_version_id" UUID,
    "file_name" VARCHAR(255),
    "private_ref" TEXT,
    "mime_type" VARCHAR(100),
    "byte_size" INTEGER,
    "sha256" VARCHAR(64),
    "companions" JSONB,
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "total_minor" DECIMAL(24,0) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "currency_exponent" INTEGER NOT NULL,
    "payment_date" DATE NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_year" INTEGER NOT NULL,
    "run_options" JSONB,
    "employer_snapshot" JSONB,
    "preflight_snapshot" JSONB,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generation_error" TEXT,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMP(6),
    "submission_reference" VARCHAR(120),
    "bank_response_at" TIMESTAMP(6),
    "bank_response_ref" VARCHAR(120),
    "bank_response_notes" TEXT,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "recorded_by" UUID,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wps_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wps_file_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wps_file_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "payroll_item_id" UUID,
    "bank_detail_id" UUID,
    "sequence" INTEGER NOT NULL,
    "employee_code_snapshot" VARCHAR(50) NOT NULL,
    "employee_name_snapshot" VARCHAR(255) NOT NULL,
    "identifier_snapshot" JSONB,
    "bank_code_snapshot" VARCHAR(20),
    "account_masked" VARCHAR(40),
    "basic_minor" DECIMAL(24,0) NOT NULL DEFAULT 0,
    "allowances_minor" DECIMAL(24,0) NOT NULL DEFAULT 0,
    "deductions_minor" DECIMAL(24,0) NOT NULL DEFAULT 0,
    "net_minor" DECIMAL(24,0) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'INCLUDED',
    "rejection_code" VARCHAR(50),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wps_file_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wps_employer_profiles_country_is_active_idx" ON "wps_employer_profiles"("country", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "wps_configurations_branch_id_key" ON "wps_configurations"("branch_id");

-- CreateIndex
CREATE INDEX "wps_configurations_enabled_idx" ON "wps_configurations"("enabled");

-- CreateIndex
CREATE INDEX "wps_files_branch_id_status_idx" ON "wps_files"("branch_id", "status");

-- CreateIndex
CREATE INDEX "wps_files_payroll_id_idx" ON "wps_files"("payroll_id");

-- CreateIndex
CREATE INDEX "wps_files_status_idx" ON "wps_files"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wps_files_payroll_id_version_key" ON "wps_files"("payroll_id", "version");

-- CreateIndex
CREATE INDEX "wps_file_rows_wps_file_id_status_idx" ON "wps_file_rows"("wps_file_id", "status");

-- CreateIndex
CREATE INDEX "wps_file_rows_employee_id_idx" ON "wps_file_rows"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "wps_file_rows_wps_file_id_employee_id_key" ON "wps_file_rows"("wps_file_id", "employee_id");

-- AddForeignKey
ALTER TABLE "wps_configurations" ADD CONSTRAINT "wps_configurations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_configurations" ADD CONSTRAINT "wps_configurations_employer_profile_id_fkey" FOREIGN KEY ("employer_profile_id") REFERENCES "wps_employer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_files" ADD CONSTRAINT "wps_files_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_files" ADD CONSTRAINT "wps_files_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_files" ADD CONSTRAINT "wps_files_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "wps_configurations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_files" ADD CONSTRAINT "wps_files_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "wps_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_file_rows" ADD CONSTRAINT "wps_file_rows_wps_file_id_fkey" FOREIGN KEY ("wps_file_id") REFERENCES "wps_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_file_rows" ADD CONSTRAINT "wps_file_rows_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_file_rows" ADD CONSTRAINT "wps_file_rows_payroll_item_id_fkey" FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wps_file_rows" ADD CONSTRAINT "wps_file_rows_bank_detail_id_fkey" FOREIGN KEY ("bank_detail_id") REFERENCES "employee_bank_details"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Concurrency guard. Only ONE generation may be in flight per payroll: the
-- generator inserts a GENERATING row first and lets this index reject the second
-- caller (translated to 409). There are no advisory locks anywhere in this
-- codebase and no interactive transactions, so a partial unique index is the
-- available primitive — the same approach as wps_configurations.branch_id.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_wps_generating_per_payroll"
  ON "wps_files" ("payroll_id") WHERE "status" = 'GENERATING';
