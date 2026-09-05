-- Final settlement: what an employee is owed when they leave.
--
-- `LoanSettlement` already carries a comment saying outright that it is "not an
-- F&F module — the gratuity / leave [encashment]", and two of its settlement
-- actions (RECOVER_FROM_GRATUITY, RECOVER_FROM_LEAVE_ENCASHMENT) recover against
-- payouts nothing computed. This is the document those actions were written for.
--
-- Note what this is NOT: `PayrollRunType.FINAL_SETTLEMENT` is a payroll RUN and
-- is unchanged. The run pays pending salary through payroll, so it reaches the
-- payslip, the wage file and the bank. This document composes the whole exit
-- package and records the working; the run's net becomes one of its lines.

CREATE TABLE "final_settlements" (
  "id"                   UUID          NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"          UUID          NOT NULL,
  "branch_id"            UUID          NOT NULL,
  "variant"              VARCHAR(20)   NOT NULL,
  "last_working_date"    DATE          NOT NULL,
  "notice_served_days"   INTEGER,
  "notice_required_days" INTEGER,
  "status"               VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
  "computed_at"          TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "working_json"         JSONB         NOT NULL,
  "total_earnings"       DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_deductions"     DECIMAL(12,2) NOT NULL DEFAULT 0,
  "net_payable"          DECIMAL(12,2) NOT NULL DEFAULT 0,
  "payroll_id"           UUID,
  "notes"                TEXT,
  "prepared_by"          UUID,
  "approved_by"          UUID,
  "approved_at"          TIMESTAMP(6),
  "paid_at"              TIMESTAMP(6),
  "cancelled_at"         TIMESTAMP(6),
  "cancel_reason"        TEXT,
  "created_at"           TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "final_settlements_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "final_settlements"
  ADD CONSTRAINT "final_settlements_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "final_settlements_employee_status_idx"
  ON "final_settlements"("employee_id", "status");
CREATE INDEX "final_settlements_branch_status_idx"
  ON "final_settlements"("branch_id", "status");

-- The rule set differs by variant in most jurisdictions — resignation before a
-- qualifying period can reduce or forfeit an entitlement that a termination
-- would not. An unrecognised variant must not silently resolve to "whatever".
ALTER TABLE "final_settlements"
  ADD CONSTRAINT "settlement_variant_known"
  CHECK ("variant" IN ('RESIGNATION', 'TERMINATION', 'RETIREMENT', 'DEATH', 'CONTRACT_END'));

ALTER TABLE "final_settlements"
  ADD CONSTRAINT "settlement_status_known"
  CHECK ("status" IN ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED'));

-- A settlement with no working is the one that loses the dispute five years
-- later, which is the entire reason the document exists rather than a payment.
ALTER TABLE "final_settlements"
  ADD CONSTRAINT "settlement_working_present"
  CHECK (jsonb_typeof("working_json") = 'object');

-- ONE open settlement per employee.
--
-- Two HR users each preparing a different settlement for the same leaver, both
-- approved, pays that person twice. Nothing in the UI prevents two people
-- opening the same screen; this does.
CREATE UNIQUE INDEX "uniq_final_settlement_live"
  ON "final_settlements"("employee_id")
  WHERE "status" IN ('DRAFT', 'APPROVED');

CREATE TABLE "final_settlement_lines" (
  "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
  "settlement_id"     UUID          NOT NULL,
  "category"          VARCHAR(20)   NOT NULL,
  "code"              VARCHAR(50)   NOT NULL,
  "label"             VARCHAR(150)  NOT NULL,
  "computed_amount"   DECIMAL(12,2) NOT NULL,
  "adjusted_amount"   DECIMAL(12,2),
  "adjustment_reason" TEXT,
  "adjusted_by"       UUID,
  "adjusted_at"       TIMESTAMP(6),
  "source_type"       VARCHAR(30),
  "source_id"         UUID,
  "display_order"     INTEGER       NOT NULL DEFAULT 0,

  CONSTRAINT "final_settlement_lines_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "final_settlement_lines"
  ADD CONSTRAINT "final_settlement_lines_settlement_id_fkey"
  FOREIGN KEY ("settlement_id") REFERENCES "final_settlements"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "final_settlement_lines_order_idx"
  ON "final_settlement_lines"("settlement_id", "display_order");

-- Same one-sign convention as payroll_item_lines, so one rule covers both.
ALTER TABLE "final_settlement_lines"
  ADD CONSTRAINT "settlement_line_category_known"
  CHECK ("category" IN ('EARNING', 'DEDUCTION'));

ALTER TABLE "final_settlement_lines"
  ADD CONSTRAINT "settlement_line_amounts_non_negative"
  CHECK ("computed_amount" >= 0
         AND ("adjusted_amount" IS NULL OR "adjusted_amount" >= 0));

-- The load-bearing constraint of this whole feature.
--
-- "Every line adjustable with a recorded reason" is only true if the reason
-- cannot be skipped. Left to the service layer it is a convention that holds
-- until someone adds a second write path; here it is a fact. HR may override
-- any line — they know things the system does not — but never silently.
ALTER TABLE "final_settlement_lines"
  ADD CONSTRAINT "settlement_line_adjustment_needs_reason"
  CHECK ("adjusted_amount" IS NULL
         OR ("adjustment_reason" IS NOT NULL
             AND length(btrim("adjustment_reason")) > 0));
