-- Flexible shifts have no fixed window: make start/end nullable and add a per-day required-hours target.
ALTER TABLE "work_schedules" ALTER COLUMN "start_time" DROP NOT NULL;
ALTER TABLE "work_schedules" ALTER COLUMN "end_time" DROP NOT NULL;
ALTER TABLE "work_schedules" ADD COLUMN IF NOT EXISTS "required_hours" DECIMAL(5,2);
