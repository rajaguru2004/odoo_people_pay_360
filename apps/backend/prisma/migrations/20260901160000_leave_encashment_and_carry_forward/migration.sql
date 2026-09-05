-- Leave encashment, and the year-end carry-forward.
--
-- `RECOVER_FROM_LEAVE_ENCASHMENT` has existed as a loan-settlement action since
-- the loans work landed, recovering against a figure nothing in the system has
-- ever produced. `leave_type_balances.carried_over` has likewise been a real
-- column with no endpoint that writes it as carry-forward. This closes both.
--
-- Inert until `leave_encashment_enabled` / `leave_carry_forward_enabled` are on.

-- ── Policy ─────────────────────────────────────────────────────────────────
CREATE TABLE "leave_type_policies" (
  "id"                          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "leave_type_key"              VARCHAR(100)  NOT NULL,
  "branch_id"                   UUID,
  "encashable"                  BOOLEAN       NOT NULL DEFAULT false,
  "max_encash_days_per_year"    INTEGER,
  "encash_basis"                VARCHAR(10)   NOT NULL DEFAULT 'BASIC',
  "month_days"                  DECIMAL(6,3)  NOT NULL DEFAULT 30,
  "accrued_only"                BOOLEAN       NOT NULL DEFAULT true,
  "allow_in_service"            BOOLEAN       NOT NULL DEFAULT true,
  "allow_on_exit"               BOOLEAN       NOT NULL DEFAULT true,
  "carry_forward_enabled"       BOOLEAN       NOT NULL DEFAULT false,
  "carry_forward_max_days"      INTEGER,
  "carry_forward_expiry_months" INTEGER,
  "is_active"                   BOOLEAN       NOT NULL DEFAULT true,
  "created_at"                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "leave_type_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_type_policies_key_idx" ON "leave_type_policies"("leave_type_key");

-- TWO partial unique indexes, not one composite unique.
--
-- Postgres treats NULLs as distinct, so `UNIQUE (leave_type_key, branch_id)`
-- would happily accept unlimited rows with a NULL branch — i.e. unlimited
-- competing "company-wide defaults" for the same leave type, with the effective
-- one decided by row order. That is exactly the bug migration 20260805100000
-- exists to fix on `payrolls`, and it is avoidable here for free.
CREATE UNIQUE INDEX "uniq_leave_type_policy_global"
  ON "leave_type_policies"("leave_type_key") WHERE "branch_id" IS NULL;
CREATE UNIQUE INDEX "uniq_leave_type_policy_branch"
  ON "leave_type_policies"("leave_type_key", "branch_id") WHERE "branch_id" IS NOT NULL;

ALTER TABLE "leave_type_policies"
  ADD CONSTRAINT "leave_type_policy_basis_known"
  CHECK ("encash_basis" IN ('BASIC', 'GROSS'));

-- It is a divisor.
ALTER TABLE "leave_type_policies"
  ADD CONSTRAINT "leave_type_policy_month_days_positive"
  CHECK ("month_days" > 0);

-- A stored 0 reads as "no cap" to a human and behaves as "cap of zero" to the
-- code. NULL is the only honest way to say "no cap".
ALTER TABLE "leave_type_policies"
  ADD CONSTRAINT "leave_type_policy_encash_cap_positive"
  CHECK ("max_encash_days_per_year" IS NULL OR "max_encash_days_per_year" > 0);

ALTER TABLE "leave_type_policies"
  ADD CONSTRAINT "leave_type_policy_carry_cap_non_negative"
  CHECK ("carry_forward_max_days" IS NULL OR "carry_forward_max_days" >= 0);

ALTER TABLE "leave_type_policies"
  ADD CONSTRAINT "leave_type_policy_expiry_positive"
  CHECK ("carry_forward_expiry_months" IS NULL OR "carry_forward_expiry_months" > 0);

-- ── Requests ───────────────────────────────────────────────────────────────
CREATE TABLE "leave_encashment_requests" (
  "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"     UUID          NOT NULL,
  "branch_id"       UUID          NOT NULL,
  "leave_type_key"  VARCHAR(100)  NOT NULL,
  "year"            INTEGER       NOT NULL,
  "days"            DECIMAL(6,2)  NOT NULL,
  "rate_per_day"    DECIMAL(12,2),
  "amount"          DECIMAL(12,2),
  "status"          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  "payroll_item_id" UUID,
  "settlement_id"   UUID,
  "reason"          TEXT,
  "requested_by"    UUID,
  "approved_by"     UUID,
  "approved_at"     TIMESTAMP(6),
  "rejected_reason" TEXT,
  "paid_at"         TIMESTAMP(6),
  "created_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "leave_encashment_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_requests_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, matching how a deleted DRAFT payroll re-releases its reimbursements:
-- an approved request whose run was thrown away must become claimable again
-- rather than disappearing with it.
ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_requests_payroll_item_id_fkey"
  FOREIGN KEY ("payroll_item_id") REFERENCES "payroll_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "leave_encashment_requests_employee_status_idx"
  ON "leave_encashment_requests"("employee_id", "status");
CREATE INDEX "leave_encashment_requests_branch_status_idx"
  ON "leave_encashment_requests"("branch_id", "status");

ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_status_known"
  CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'));

ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_days_positive"
  CHECK ("days" > 0);

-- A paid encashment with no stored rate is a figure nobody can defend once the
-- salary changes — and salaries change.
ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_paid_has_rate"
  CHECK ("status" <> 'PAID'
         OR ("amount" IS NOT NULL AND "rate_per_day" IS NOT NULL));

-- The double-payment guard, and the reason this is a CHECK rather than a
-- service-layer rule: paid through payroll AND through a final settlement is
-- the failure mode, it pays an employee twice, and no amount of care in two
-- separate code paths prevents it as reliably as one constraint does.
ALTER TABLE "leave_encashment_requests"
  ADD CONSTRAINT "leave_encashment_paid_one_destination"
  CHECK ("status" <> 'PAID'
         OR (("payroll_item_id" IS NOT NULL)::int
             + ("settlement_id" IS NOT NULL)::int = 1));

-- Mirrors the reimbursement double-inclusion guard: one payslip line per
-- request, so a second run cannot claim a request the first already paid.
CREATE UNIQUE INDEX "uniq_leave_encashment_per_item"
  ON "leave_encashment_requests"("payroll_item_id")
  WHERE "payroll_item_id" IS NOT NULL;

-- One live request per employee, leave type and year. Two competing requests
-- for the same balance is how an employee is paid for days twice.
CREATE UNIQUE INDEX "uniq_leave_encashment_live"
  ON "leave_encashment_requests"("employee_id", "leave_type_key", "year")
  WHERE "status" IN ('PENDING', 'APPROVED');

-- ── Carry-forward ──────────────────────────────────────────────────────────
CREATE TABLE "leave_carry_forward_runs" (
  "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
  "branch_id"       UUID          NOT NULL,
  "from_year"       INTEGER       NOT NULL,
  "to_year"         INTEGER       NOT NULL,
  "leave_type_keys" TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
  "employee_count"  INTEGER       NOT NULL DEFAULT 0,
  "days_carried"    DECIMAL(10,2) NOT NULL DEFAULT 0,
  "days_lapsed"     DECIMAL(10,2) NOT NULL DEFAULT 0,
  "status"          VARCHAR(20)   NOT NULL DEFAULT 'APPLIED',
  "working_json"    JSONB         NOT NULL,
  "executed_by"     UUID,
  "executed_at"     TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_by"     UUID,
  "reversed_at"     TIMESTAMP(6),

  CONSTRAINT "leave_carry_forward_runs_pkey" PRIMARY KEY ("id")
);

-- Idempotency. Running the year end twice is an ordinary human mistake, and
-- without this it silently doubles every employee's carried balance.
CREATE UNIQUE INDEX "uniq_leave_carry_forward_run"
  ON "leave_carry_forward_runs"("branch_id", "from_year", "to_year");

ALTER TABLE "leave_carry_forward_runs"
  ADD CONSTRAINT "leave_carry_forward_status_known"
  CHECK ("status" IN ('APPLIED', 'REVERSED'));

ALTER TABLE "leave_carry_forward_runs"
  ADD CONSTRAINT "leave_carry_forward_years_ordered"
  CHECK ("to_year" > "from_year");

-- Stamps on the balances a run touched, so a reversal can undo exactly those
-- rows and nothing an accrual or an allocation wrote afterwards.
ALTER TABLE "leave_type_balances"
  ADD COLUMN "carried_over_expires_on" DATE,
  ADD COLUMN "carried_from_year"       INTEGER,
  ADD COLUMN "carry_forward_run_id"    UUID;

-- ── The payslip column ─────────────────────────────────────────────────────
--
-- Its own column rather than folded into `bonus`. `bonus` means rewards; using
-- it for encashment would overload a column whose meaning several reports
-- already depend on, and would make "is encashment taxable?" a migration rather
-- than a setting. Defaulted to 0, so with the feature off it contributes
-- nothing: `x + 0` is exact.
ALTER TABLE "payroll_items"
  ADD COLUMN "leave_encashment" DECIMAL(12,2) NOT NULL DEFAULT 0;
