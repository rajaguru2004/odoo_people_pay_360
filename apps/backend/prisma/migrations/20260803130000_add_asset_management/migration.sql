-- Asset management (HR half only — no depreciation/disposal accounting).
--
-- The business value is offboarding clearance: a leaver cannot be completed
-- while an assignment is still open. That check reads `returned_at IS NULL`,
-- never Employee.status, so the existing INACTIVE-vs-TERMINATED inconsistency
-- does not affect it.

-- New master-data category. ALTER TYPE ... ADD VALUE cannot be used in the same
-- transaction that adds it, so nothing below references 'ASSET_CATEGORY' —
-- LibraryItemsService.onModuleInit() seeds the default categories on boot.
ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'ASSET_CATEGORY';

CREATE TABLE IF NOT EXISTS "asset_items" (
    "id"              UUID          NOT NULL DEFAULT gen_random_uuid(),
    "asset_tag"       VARCHAR(50)   NOT NULL,
    "category"        VARCHAR(100)  NOT NULL,
    "name"            VARCHAR(200)  NOT NULL,
    "serial_number"   VARCHAR(150),
    "branch_id"       UUID          NOT NULL,
    "status"          VARCHAR(20)   NOT NULL DEFAULT 'AVAILABLE',
    "purchase_date"   DATE,
    "purchase_cost"   DECIMAL(12,2),
    "warranty_expiry" DATE,
    "notes"           TEXT,
    "created_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "asset_items_asset_tag_key"
    ON "asset_items" ("asset_tag");
CREATE INDEX IF NOT EXISTS "asset_items_branch_id_status_idx"
    ON "asset_items" ("branch_id", "status");
CREATE INDEX IF NOT EXISTS "asset_items_warranty_expiry_idx"
    ON "asset_items" ("warranty_expiry");
CREATE INDEX IF NOT EXISTS "asset_items_category_idx"
    ON "asset_items" ("category");

CREATE TABLE IF NOT EXISTS "asset_assignments" (
    "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
    "asset_id"              UUID         NOT NULL,
    "employee_id"           UUID         NOT NULL,
    "assigned_at"           DATE         NOT NULL,
    "assigned_by_id"        UUID         NOT NULL,
    "condition_out"         VARCHAR(50),
    "acknowledged_at"       TIMESTAMP(6),
    "acknowledged_note"     TEXT,
    "returned_at"           DATE,
    "condition_in"          VARCHAR(50),
    "return_received_by_id" UUID,
    "notes"                 TEXT,
    "created_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "asset_assignments_employee_id_returned_at_idx"
    ON "asset_assignments" ("employee_id", "returned_at");
CREATE INDEX IF NOT EXISTS "asset_assignments_asset_id_idx"
    ON "asset_assignments" ("asset_id");

-- One asset cannot be held by two people at once. Enforced in the database
-- rather than only in the service, because a lost race here silently produces
-- an asset that two employees must both return before either can leave.
CREATE UNIQUE INDEX IF NOT EXISTS "asset_assignments_one_open_per_asset"
    ON "asset_assignments" ("asset_id")
    WHERE "returned_at" IS NULL;

DO $$
BEGIN
    ALTER TABLE "asset_items" ADD CONSTRAINT "asset_items_branch_id_fkey"
        FOREIGN KEY ("branch_id") REFERENCES "branches"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_asset_id_fkey"
        FOREIGN KEY ("asset_id") REFERENCES "asset_items"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_employee_id_fkey"
        FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_assigned_by_id_fkey"
        FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "asset_assignments" ADD CONSTRAINT "asset_assignments_return_received_by_id_fkey"
        FOREIGN KEY ("return_received_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
