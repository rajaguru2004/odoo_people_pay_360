-- Per-tier overtime hour buckets. Existing rows default to 0 and are handled by
-- the payroll legacy-fallback (single tier reconstructed from ot_type).
ALTER TABLE "overtime_requests"
  ADD COLUMN IF NOT EXISTS "regular_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "late_hours"    DECIMAL(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "double_hours"  DECIMAL(5,2) NOT NULL DEFAULT 0;
