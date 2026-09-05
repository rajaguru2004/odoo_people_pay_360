-- Travel management, built as an EXTENSION of reimbursements.
--
-- A TravelRequest owns the trip and its multi-level approval. Every currency
-- amount it produces becomes an ordinary `reimbursements` row tagged
-- source_type='TRAVEL', so the existing payroll payout path (payroll_item_id
-- back-link, APPROVED -> PAID at lock) carries it with no changes.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- so nothing in this file references 'TRAVEL' or 'PER_DIEM_DESTINATION'.

ALTER TYPE "ApprovalRequestType" ADD VALUE IF NOT EXISTS 'TRAVEL';
ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'PER_DIEM_DESTINATION';

-- Per-diem rate metadata on the shared library table, matching the existing
-- wide-column pattern (cf. pay_basis for EMPLOYMENT_TYPE).
ALTER TABLE "library_items"
    ADD COLUMN IF NOT EXISTS "per_diem_rate" DECIMAL(12,2);

-- Provenance on reimbursements. All nullable: existing standalone claims are
-- untouched and keep working exactly as before.
ALTER TABLE "reimbursements"
    ADD COLUMN IF NOT EXISTS "source_type"     VARCHAR(30),
    ADD COLUMN IF NOT EXISTS "source_id"       UUID,
    ADD COLUMN IF NOT EXISTS "budget_category" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "reimbursements_source_type_source_id_idx"
    ON "reimbursements" ("source_type", "source_id");

CREATE TABLE IF NOT EXISTS "travel_requests" (
    "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
    "employee_id"      UUID          NOT NULL,
    "purpose"          TEXT          NOT NULL,
    "travel_type"      VARCHAR(20)   NOT NULL,
    "destination"      VARCHAR(200)  NOT NULL,
    "country"          VARCHAR(100),
    "departure_date"   DATE          NOT NULL,
    "return_date"      DATE          NOT NULL,
    "per_diem_rate"    DECIMAL(12,2),
    "per_diem_days"    INTEGER,
    "estimated_cost"   DECIMAL(12,2) NOT NULL,
    "advance_amount"   DECIMAL(12,2),
    "advance_loan_id"  UUID,
    "status"           VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
    "approver_id"      UUID,
    "approved_at"      TIMESTAMP(6),
    "approver_remarks" TEXT,
    "rejected_reason"  TEXT,
    "created_at"       TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travel_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "travel_requests_employee_id_status_idx"
    ON "travel_requests" ("employee_id", "status");
CREATE INDEX IF NOT EXISTS "travel_requests_departure_date_return_date_idx"
    ON "travel_requests" ("departure_date", "return_date");
CREATE INDEX IF NOT EXISTS "travel_requests_status_idx"
    ON "travel_requests" ("status");

CREATE TABLE IF NOT EXISTS "travel_itineraries" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "travel_id"  UUID         NOT NULL,
    "leg_order"  INTEGER      NOT NULL,
    "mode"       VARCHAR(30)  NOT NULL,
    "from_place" VARCHAR(200),
    "to_place"   VARCHAR(200),
    "start_at"   TIMESTAMP(6) NOT NULL,
    "end_at"     TIMESTAMP(6),
    "reference"  VARCHAR(150),
    "notes"      TEXT,

    CONSTRAINT "travel_itineraries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "travel_itineraries_travel_id_leg_order_key"
    ON "travel_itineraries" ("travel_id", "leg_order");

DO $$
BEGIN
    ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_approver_id_fkey"
        FOREIGN KEY ("approver_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_advance_loan_id_fkey"
        FOREIGN KEY ("advance_loan_id") REFERENCES "advance_loan_requests"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "travel_itineraries" ADD CONSTRAINT "travel_itineraries_travel_id_fkey"
        FOREIGN KEY ("travel_id") REFERENCES "travel_requests"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
