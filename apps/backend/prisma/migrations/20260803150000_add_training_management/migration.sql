-- Training management, built like travel: an EXTENSION of reimbursements.
--
-- A nomination owns the request and its approval; when the employee pays and is
-- reimbursed the cost becomes an ordinary `reimbursements` row tagged
-- source_type='TRAINING'. No training-expense table, no second payout path.
--
-- The differentiator lives in training_nominations.source='APPRAISAL' +
-- appraisal_result_id: training needs derived from the AI appraisal engine,
-- with the provenance kept so a recommendation can be traced to its evidence.

ALTER TYPE "ApprovalRequestType" ADD VALUE IF NOT EXISTS 'TRAINING';
ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'COURSE_CATEGORY';

CREATE TABLE IF NOT EXISTS "courses" (
    "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
    "code"              VARCHAR(50)   NOT NULL,
    "title"             VARCHAR(200)  NOT NULL,
    "category"          VARCHAR(100),
    "provider"          VARCHAR(200),
    "description"       TEXT,
    "duration_hours"    DECIMAL(6,2),
    "default_cost"      DECIMAL(12,2),
    "cert_valid_months" INTEGER,
    "is_active"         BOOLEAN       NOT NULL DEFAULT true,
    "created_at"        TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "courses_code_key" ON "courses" ("code");
CREATE INDEX IF NOT EXISTS "courses_is_active_idx" ON "courses" ("is_active");

CREATE TABLE IF NOT EXISTS "training_sessions" (
    "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
    "course_id"     UUID          NOT NULL,
    "branch_id"     UUID,
    "start_date"    DATE          NOT NULL,
    "end_date"      DATE          NOT NULL,
    "location"      VARCHAR(200),
    "trainer"       VARCHAR(200),
    "seats"         INTEGER,
    "cost_per_seat" DECIMAL(12,2),
    "status"        VARCHAR(20)   NOT NULL DEFAULT 'SCHEDULED',
    "created_at"    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "training_sessions_start_date_idx"
    ON "training_sessions" ("start_date");
CREATE INDEX IF NOT EXISTS "training_sessions_status_idx"
    ON "training_sessions" ("status");

CREATE TABLE IF NOT EXISTS "training_nominations" (
    "id"                  UUID          NOT NULL DEFAULT gen_random_uuid(),
    "session_id"          UUID          NOT NULL,
    "employee_id"         UUID          NOT NULL,
    "nominated_by_id"     UUID          NOT NULL,
    "source"              VARCHAR(20)   NOT NULL DEFAULT 'MANUAL',
    "appraisal_result_id" UUID,
    "justification"       TEXT,
    "cost"                DECIMAL(12,2),
    "status"              VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
    "approver_id"         UUID,
    "approved_at"         TIMESTAMP(6),
    "rejected_reason"     TEXT,
    "attended_at"         DATE,
    "score"               DECIMAL(6,2),
    "passed"              BOOLEAN,
    "certificate_url"     TEXT,
    "certificate_expiry"  DATE,
    "created_at"          TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_nominations_pkey" PRIMARY KEY ("id")
);

-- One nomination per employee per session: re-nominating must be an update, not
-- a second approval for the same seat.
CREATE UNIQUE INDEX IF NOT EXISTS "training_nominations_session_id_employee_id_key"
    ON "training_nominations" ("session_id", "employee_id");
CREATE INDEX IF NOT EXISTS "training_nominations_employee_id_status_idx"
    ON "training_nominations" ("employee_id", "status");
CREATE INDEX IF NOT EXISTS "training_nominations_certificate_expiry_idx"
    ON "training_nominations" ("certificate_expiry");

DO $$
BEGIN
    ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_course_id_fkey"
        FOREIGN KEY ("course_id") REFERENCES "courses"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_branch_id_fkey"
        FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_nominations" ADD CONSTRAINT "training_nominations_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_nominations" ADD CONSTRAINT "training_nominations_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_nominations" ADD CONSTRAINT "training_nominations_nominated_by_id_fkey"
        FOREIGN KEY ("nominated_by_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_nominations" ADD CONSTRAINT "training_nominations_approver_id_fkey"
        FOREIGN KEY ("approver_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "training_nominations" ADD CONSTRAINT "training_nominations_appraisal_result_id_fkey"
        FOREIGN KEY ("appraisal_result_id") REFERENCES "appraisal_results"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
