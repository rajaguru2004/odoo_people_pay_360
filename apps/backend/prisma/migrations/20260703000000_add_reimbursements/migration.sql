-- Reimbursement management: employee expense claims with configurable approvers,
-- payroll auto-inclusion (non-taxable) and PAID flip on payroll lock.

CREATE TABLE IF NOT EXISTS "reimbursements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expense_date" DATE NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "approver_id" UUID,
    "approved_at" TIMESTAMP(6),
    "approver_remarks" TEXT,
    "rejected_reason" TEXT,
    "payroll_item_id" UUID,
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reimbursements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "reimbursement_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reimbursement_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" BIGINT,
    "mime_type" VARCHAR(100),
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),

    CONSTRAINT "reimbursement_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reimbursements_employee_id_idx" ON "reimbursements"("employee_id");
CREATE INDEX IF NOT EXISTS "reimbursements_status_idx" ON "reimbursements"("status");
CREATE INDEX IF NOT EXISTS "reimbursements_payroll_item_id_idx" ON "reimbursements"("payroll_item_id");
CREATE INDEX IF NOT EXISTS "reimbursement_attachments_reimbursement_id_idx" ON "reimbursement_attachments"("reimbursement_id");

ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_approver_id_fkey"
    FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_payroll_item_id_fkey"
    FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reimbursement_attachments" ADD CONSTRAINT "reimbursement_attachments_reimbursement_id_fkey"
    FOREIGN KEY ("reimbursement_id") REFERENCES "reimbursements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reimbursement_attachments" ADD CONSTRAINT "reimbursement_attachments_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payroll_items" ADD COLUMN IF NOT EXISTS "reimbursement" DECIMAL(12,2) NOT NULL DEFAULT 0;
