-- CreateEnum
CREATE TYPE "LegalDocumentCategory" AS ENUM ('VISA');

-- AlterEnum
ALTER TYPE "LibraryType" ADD VALUE 'VISA_TYPE';

-- CreateTable
CREATE TABLE "employee_legal_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "category" "LegalDocumentCategory" NOT NULL DEFAULT 'VISA',
    "document_number" VARCHAR(100) NOT NULL,
    "document_type" VARCHAR(100) NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "issue_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "issuing_authority" VARCHAR(200),
    "place_of_issue" VARCHAR(200),
    "sponsor" VARCHAR(200),
    "remarks" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "renewed_from_id" UUID,
    "expiry_alert_sent_at" TIMESTAMP(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_document_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "legal_document_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" BIGINT,
    "mime_type" VARCHAR(100),
    "uploaded_by_id" UUID,
    "uploaded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_document_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_legal_documents_employee_id_category_idx" ON "employee_legal_documents"("employee_id", "category");

-- CreateIndex
CREATE INDEX "employee_legal_documents_category_status_idx" ON "employee_legal_documents"("category", "status");

-- CreateIndex
CREATE INDEX "employee_legal_documents_expiry_date_idx" ON "employee_legal_documents"("expiry_date");

-- CreateIndex
CREATE INDEX "legal_document_attachments_legal_document_id_idx" ON "legal_document_attachments"("legal_document_id");

-- AddForeignKey
ALTER TABLE "employee_legal_documents" ADD CONSTRAINT "employee_legal_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_legal_documents" ADD CONSTRAINT "employee_legal_documents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_legal_documents" ADD CONSTRAINT "employee_legal_documents_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "employee_legal_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_document_attachments" ADD CONSTRAINT "legal_document_attachments_legal_document_id_fkey" FOREIGN KEY ("legal_document_id") REFERENCES "employee_legal_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_document_attachments" ADD CONSTRAINT "legal_document_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Exactly one current record per (employee, category, country).
-- Partial unique index — Prisma cannot express this; same pattern as per-branch holiday indexes.
CREATE UNIQUE INDEX "employee_legal_documents_current_unique"
  ON "employee_legal_documents"("employee_id", "category", "country")
  WHERE "is_current" = true;

-- Document numbers unique within a category (visa numbers must not collide).
CREATE UNIQUE INDEX "employee_legal_documents_category_number_unique"
  ON "employee_legal_documents"("category", "document_number");
