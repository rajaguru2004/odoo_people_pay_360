-- AddColumn: geo location fields to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "location_name" VARCHAR(500);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(10,7);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(10,7);
