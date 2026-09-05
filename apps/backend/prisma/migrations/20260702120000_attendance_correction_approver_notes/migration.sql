-- Persist approver notes when an attendance-correction request is approved.
ALTER TABLE "attendance_corrections" ADD COLUMN IF NOT EXISTS "approver_notes" TEXT;
