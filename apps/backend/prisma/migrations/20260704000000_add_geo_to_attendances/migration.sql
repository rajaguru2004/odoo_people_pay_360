-- AddColumn: check-in geo location fields to attendances
ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "check_in_latitude" DECIMAL(10,7);
ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "check_in_longitude" DECIMAL(10,7);
ALTER TABLE "attendances" ADD COLUMN IF NOT EXISTS "check_in_accuracy_m" DECIMAL(8,2);
