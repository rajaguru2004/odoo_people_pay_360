-- CreateTable
CREATE TABLE "payroll_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_batch_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    CONSTRAINT "payroll_batch_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_batch_members_batch_id_employee_id_key" ON "payroll_batch_members"("batch_id", "employee_id");

-- AddForeignKey
ALTER TABLE "payroll_batch_members" ADD CONSTRAINT "payroll_batch_members_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payroll_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_batch_members" ADD CONSTRAINT "payroll_batch_members_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "payrolls" ADD COLUMN "batch_id" UUID;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payroll_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterIndex
ALTER TABLE "payrolls" DROP CONSTRAINT IF EXISTS "payrolls_month_year_key";
DROP INDEX IF EXISTS "payrolls_month_year_key";
CREATE UNIQUE INDEX "payrolls_month_year_batch_id_key" ON "payrolls"("month", "year", "batch_id");
