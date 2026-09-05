-- The carry-forward ledger: whatever a run could not take because net ran out.
--
-- Not garnishment-specific, which is why it outlived the garnishment model it
-- was first written beside. Three things carry: a court order larger than
-- available pay, an employer recovery the loan ladder left no room for, and a
-- manual payslip deduction that exceeded net. All three would otherwise be
-- silently forgiven for that period.
--
-- The `garnishments` table this migration originally created is gone: the
-- surviving court-order tables are `garnishment_orders` and
-- `garnishment_deductions` from 20260819120000/130000. `source_id` here is a
-- bare UUID with no foreign key, so it points at a `garnishment_orders` row
-- just as well as it pointed at the old one.

CREATE TABLE "payroll_carry_forwards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "source_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "amount_recovered" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OUTSTANDING',
    "origin_payroll_id" UUID,
    "cleared_payroll_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" TIMESTAMP(6),

    CONSTRAINT "payroll_carry_forwards_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "carry_forward_kind_known"
    CHECK ("kind" IN ('GARNISHMENT', 'DEDUCTION'));

ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "carry_forward_status_known"
    CHECK ("status" IN ('OUTSTANDING', 'RECOVERED', 'RECEIVABLE', 'WAIVED'));

ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "carry_forward_amount_positive"
    CHECK ("amount" > 0);

-- Never take more than was carried.
ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "carry_forward_recovery_within_amount"
    CHECK ("amount_recovered" >= 0 AND "amount_recovered" <= "amount");

CREATE INDEX "payroll_carry_forwards_employee_id_status_idx" ON "payroll_carry_forwards"("employee_id", "status");
CREATE INDEX "payroll_carry_forwards_branch_id_status_idx" ON "payroll_carry_forwards"("branch_id", "status");

ALTER TABLE "payroll_carry_forwards" ADD CONSTRAINT "payroll_carry_forwards_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The most recent run to take something off a carried balance, and how much.
-- Without these, deleting or unlocking a run could only put back the balances
-- it cleared IN FULL: a partial recovery had no record of its own size, so the
-- reversal silently under-restored the debt.
ALTER TABLE "payroll_carry_forwards"
    ADD COLUMN "last_recovery_payroll_id" UUID,
    ADD COLUMN "last_recovery_amount" DECIMAL(12,2);
