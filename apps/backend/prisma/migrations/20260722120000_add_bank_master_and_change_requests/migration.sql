-- AlterEnum
ALTER TYPE "ApprovalRequestType" ADD VALUE 'BANK_CHANGE';

-- CreateTable
CREATE TABLE "banks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "country" VARCHAR(2) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "bank_code" VARCHAR(20),
    "swift" VARCHAR(11),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_details" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "iban" VARCHAR(34) NOT NULL,
    "account_number" VARCHAR(50),
    "account_holder_name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(20) NOT NULL DEFAULT 'APPROVAL',
    "source_request_id" UUID,
    "branch_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_bank_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "iban" VARCHAR(34) NOT NULL,
    "account_number" VARCHAR(50),
    "account_holder_name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID NOT NULL,
    "branch_id" UUID,
    "decided_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "banks_country_name_key" ON "banks"("country", "name");

-- CreateIndex
CREATE INDEX "banks_country_is_active_idx" ON "banks"("country", "is_active");

-- CreateIndex
CREATE INDEX "employee_bank_details_employee_id_is_active_idx" ON "employee_bank_details"("employee_id", "is_active");

-- At most one active bank detail per employee (partial unique index).
CREATE UNIQUE INDEX "uniq_active_bank_detail" ON "employee_bank_details"("employee_id") WHERE "is_active";

-- CreateIndex
CREATE INDEX "bank_change_requests_employee_id_status_idx" ON "bank_change_requests"("employee_id", "status");

-- At most one pending change request per employee (partial unique index).
CREATE UNIQUE INDEX "uniq_pending_bank_change" ON "bank_change_requests"("employee_id") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "employee_bank_details" ADD CONSTRAINT "employee_bank_details_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_bank_details" ADD CONSTRAINT "employee_bank_details_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_change_requests" ADD CONSTRAINT "bank_change_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_change_requests" ADD CONSTRAINT "bank_change_requests_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
