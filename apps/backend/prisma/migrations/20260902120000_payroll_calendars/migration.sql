-- The payroll calendar: cut-off and payment dates, per branch and period.
--
-- `payrolls` carries `month` and `year` and nothing else that describes a
-- period, so two catalogue cases that turn on a cut-off — "employee resigns on
-- the cut-off date", "salary revision effective before the cut-off" — have only
-- ever been testable as re-readings against the period end.
--
-- What this migration does NOT do is as important as what it does: the period
-- identity and `uniq_payroll_period_branch_batch_version` are untouched, and no
-- engine window is driven from here in this change. A calendar describes a
-- period; it never keys one. With no calendar row, every branch behaves exactly
-- as it does today.

CREATE TABLE "payroll_calendars" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "branch_id"  UUID         NOT NULL,
  "year"       INTEGER      NOT NULL,
  "name"       VARCHAR(100),
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payroll_calendars_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uniq_payroll_calendar_branch_year"
  ON "payroll_calendars"("branch_id", "year");

ALTER TABLE "payroll_calendars"
  ADD CONSTRAINT "payroll_calendar_year_valid"
  CHECK ("year" BETWEEN 2000 AND 2100);

CREATE TABLE "payroll_calendar_periods" (
  "id"              UUID    NOT NULL DEFAULT gen_random_uuid(),
  "calendar_id"     UUID    NOT NULL,
  "month"           INTEGER NOT NULL,
  "period_start"    DATE    NOT NULL,
  "period_end"      DATE    NOT NULL,
  "cut_off_date"    DATE    NOT NULL,
  "payment_date"    DATE    NOT NULL,
  "enforce_cut_off" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "payroll_calendar_periods_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payroll_calendar_periods"
  ADD CONSTRAINT "payroll_calendar_periods_calendar_id_fkey"
  FOREIGN KEY ("calendar_id") REFERENCES "payroll_calendars"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "uniq_payroll_calendar_period"
  ON "payroll_calendar_periods"("calendar_id", "month");

-- The run's identity is (month, year), so a 13 could never be reached by any
-- payroll and would sit in the table forever looking like configuration.
ALTER TABLE "payroll_calendar_periods"
  ADD CONSTRAINT "calendar_period_month_range"
  CHECK ("month" BETWEEN 1 AND 12);

ALTER TABLE "payroll_calendar_periods"
  ADD CONSTRAINT "calendar_period_dates_ordered"
  CHECK ("period_end" >= "period_start");

-- A cut-off before the period opens flags EVERY input in the period, which
-- reads as a broken feature rather than a policy nobody meant to set.
ALTER TABLE "payroll_calendar_periods"
  ADD CONSTRAINT "calendar_period_cutoff_within"
  CHECK ("cut_off_date" >= "period_start");

-- Paying before the period closes is not a payroll. This is also the field a
-- wage file's value date would come from, and a bank rejects a past-dated one.
ALTER TABLE "payroll_calendar_periods"
  ADD CONSTRAINT "calendar_period_payment_after_period"
  CHECK ("payment_date" >= "period_end");

-- Deliberately absent: any constraint tying period_start/period_end to the
-- calendar month. That freedom is the point — a 26th-to-25th period is a real
-- payroll period and has to be expressible.
