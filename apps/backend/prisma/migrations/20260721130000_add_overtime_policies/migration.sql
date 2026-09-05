-- AlterTable
-- employment_type is a CONTRACT_TYPE library label (free string, nullable).
-- Null = not set → the employee falls through to the company default policy.
ALTER TABLE "employees" ADD COLUMN     "employment_type" VARCHAR(100),
ADD COLUMN     "overtime_policy_id" UUID;

-- AlterTable
ALTER TABLE "overtime_requests" ADD COLUMN     "overtime_policy_id" UUID;

-- CreateTable
CREATE TABLE "overtime_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "employment_type" VARCHAR(100),
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "rules" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "overtime_policies_name_key" ON "overtime_policies"("name");

-- CreateIndex
CREATE INDEX "overtime_policies_is_active_idx" ON "overtime_policies"("is_active");

-- CreateIndex
CREATE INDEX "overtime_policies_employment_type_idx" ON "overtime_policies"("employment_type");

-- One active default policy company-wide (partial unique index).
CREATE UNIQUE INDEX "overtime_policies_default_active_key" ON "overtime_policies"("is_default") WHERE "is_default" AND "is_active";

-- At most one active policy per employment type (partial unique index).
CREATE UNIQUE INDEX "overtime_policies_emptype_active_key" ON "overtime_policies"("employment_type") WHERE "employment_type" IS NOT NULL AND "is_active";

-- CreateIndex
CREATE INDEX "employees_overtime_policy_id_idx" ON "employees"("overtime_policy_id");

-- CreateIndex
CREATE INDEX "overtime_requests_overtime_policy_id_idx" ON "overtime_requests"("overtime_policy_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_overtime_policy_id_fkey" FOREIGN KEY ("overtime_policy_id") REFERENCES "overtime_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_overtime_policy_id_fkey" FOREIGN KEY ("overtime_policy_id") REFERENCES "overtime_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
