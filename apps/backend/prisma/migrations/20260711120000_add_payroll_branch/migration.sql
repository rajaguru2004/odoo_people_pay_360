-- AlterTable
ALTER TABLE "payroll_batches" ADD COLUMN     "branch_id" UUID;

-- AlterTable
ALTER TABLE "payrolls" ADD COLUMN     "branch_id" UUID;

-- CreateIndex
CREATE INDEX "payroll_batches_branch_id_idx" ON "payroll_batches"("branch_id");

-- CreateIndex
CREATE INDEX "payrolls_branch_id_idx" ON "payrolls"("branch_id");

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

