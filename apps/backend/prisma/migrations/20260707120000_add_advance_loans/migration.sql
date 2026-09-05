-- AlterTable
ALTER TABLE "payroll_items" ADD COLUMN     "advance_loan_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "advance_loan_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "installments" INTEGER NOT NULL DEFAULT 1,
    "installment_amount" DECIMAL(12,2),
    "amount_repaid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "approver_id" UUID,
    "approved_at" TIMESTAMP(6),
    "approver_remarks" TEXT,
    "rejected_reason" TEXT,
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_loan_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_loan_deductions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "payroll_item_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_loan_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_loan_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" BIGINT,
    "mime_type" VARCHAR(100),
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),

    CONSTRAINT "advance_loan_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "advance_loan_requests_employee_id_idx" ON "advance_loan_requests"("employee_id");

-- CreateIndex
CREATE INDEX "advance_loan_requests_status_idx" ON "advance_loan_requests"("status");

-- CreateIndex
CREATE INDEX "advance_loan_requests_type_idx" ON "advance_loan_requests"("type");

-- CreateIndex
CREATE INDEX "advance_loan_deductions_request_id_idx" ON "advance_loan_deductions"("request_id");

-- CreateIndex
CREATE INDEX "advance_loan_deductions_payroll_item_id_idx" ON "advance_loan_deductions"("payroll_item_id");

-- CreateIndex
CREATE INDEX "advance_loan_deductions_status_idx" ON "advance_loan_deductions"("status");

-- CreateIndex
CREATE INDEX "advance_loan_attachments_request_id_idx" ON "advance_loan_attachments"("request_id");

-- AddForeignKey
ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_requests" ADD CONSTRAINT "advance_loan_requests_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_deductions" ADD CONSTRAINT "advance_loan_deductions_payroll_item_id_fkey" FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_attachments" ADD CONSTRAINT "advance_loan_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "advance_loan_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_loan_attachments" ADD CONSTRAINT "advance_loan_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

