-- Branch transfer, as a reviewed flow.
--
-- `UpdateEmployeeDto` omits `branchId` on purpose, and its comment says why:
-- moving an employee between branches crosses the isolation axis, so it "needs
-- its own reviewed flow rather than a field on this form".
--
-- Note what does NOT change: the DTO still omits `branchId`, so
-- `PATCH /employees/:id { branchId }` still answers
-- ["property branchId should not exist"], and the e2e case asserting that stays
-- true. A transfer is a different route, not a looser form.

CREATE TABLE "employee_transfers" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"        UUID         NOT NULL,
  "from_branch_id"     UUID         NOT NULL,
  "to_branch_id"       UUID         NOT NULL,
  "from_department_id" UUID,
  "to_department_id"   UUID,
  "effective_date"     DATE         NOT NULL,
  "reason"             TEXT         NOT NULL,
  "status"             VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "requested_by"       UUID,
  "approved_by"        UUID,
  "approved_at"        TIMESTAMP(6),
  "rejected_reason"    TEXT,
  "applied_at"         TIMESTAMP(6),
  "cancelled_at"       TIMESTAMP(6),
  "notes"              TEXT,
  "created_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "employee_transfers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "employee_transfers"
  ADD CONSTRAINT "employee_transfers_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "employee_transfers_employee_status_idx"
  ON "employee_transfers"("employee_id", "status");
CREATE INDEX "employee_transfers_to_branch_status_idx"
  ON "employee_transfers"("to_branch_id", "status");
CREATE INDEX "employee_transfers_effective_date_idx"
  ON "employee_transfers"("effective_date");

ALTER TABLE "employee_transfers"
  ADD CONSTRAINT "transfer_status_known"
  CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'CANCELLED'));

-- A same-branch transfer is a no-op that would still move payroll ownership
-- through the audit trail and make "which branch pays them?" ambiguous for a
-- period where nothing actually changed.
ALTER TABLE "employee_transfers"
  ADD CONSTRAINT "transfer_branches_differ"
  CHECK ("from_branch_id" <> "to_branch_id");

-- ONE open transfer per employee.
--
-- Two queued transfers with different effective dates make "which branch pays
-- them this month?" unanswerable, and the answer would depend on which row was
-- read first.
CREATE UNIQUE INDEX "uniq_employee_transfer_open"
  ON "employee_transfers"("employee_id")
  WHERE "status" IN ('PENDING', 'APPROVED');
