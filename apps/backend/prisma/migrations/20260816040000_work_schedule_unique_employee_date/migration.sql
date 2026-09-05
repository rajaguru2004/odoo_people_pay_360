-- Time & Schedules (Phase 3, T5): close the check-then-create race on work_schedules.
--
-- WHAT THE RACE IS
--
-- `hasScheduleConflict` and the INSERT that follows it are separate statements
-- with no transaction around them, so two concurrent creates both read "no
-- conflict" and both land. The duplicate is invisible on the schedule matrix
-- (which renders the first row it finds for an employee-day) and visible in the
-- stat tile above it (which COUNTS rows), so the same screen contradicts itself.
--
-- WHY NOT UNIQUE (employee_id, date)
--
-- Because a split day is legitimate. `WorkSchedule` deliberately allows two
-- shifts on one date as long as their windows do not overlap — the comparison is
-- half-open precisely so that a 09:00-12:00 and a 12:00-15:00 pair is accepted,
-- and `SCH-API-28` / `BULK-API-21` assert it. A plain unique on (employee, date)
-- would forbid every one of those, trading a race for a lost capability.
--
-- WHAT THIS ENFORCES INSTEAD
--
--   UNIQUE (employee_id, date, start_time) NULLS NOT DISTINCT
--
--   * two fixed shifts with DIFFERENT start times   -> allowed  (the split day)
--   * two fixed shifts with the SAME start time     -> refused  (they must overlap)
--   * two FLEXIBLE rows on one day                  -> refused  (start_time is
--       NULL for both, and NULLS NOT DISTINCT — PostgreSQL 15+ — makes NULL
--       collide with NULL instead of being distinct from it)
--
-- The one combination the index cannot catch is a FLEXIBLE row racing a fixed
-- one on the same date; that pairing is still refused by `hasScheduleConflict`
-- at the service, so the remaining window is narrow and its worst case is a
-- state the application already rejects on the next write.

-- 1. Dedup anything already stored, on the same key the index will enforce.
--    Keep the OLDEST row: it is the one whose id has been handed to clients, put
--    on calendars and referenced by any link somebody saved. The later duplicate
--    is the accident.
DELETE FROM work_schedules a
USING work_schedules b
WHERE a.employee_id = b.employee_id
  AND a.date        = b.date
  AND a.start_time IS NOT DISTINCT FROM b.start_time
  AND (
        a.created_at > b.created_at
     OR (a.created_at = b.created_at AND a.id > b.id)
  );

-- 2. Then the constraint itself.
CREATE UNIQUE INDEX IF NOT EXISTS "work_schedules_employee_date_start_uq"
  ON "work_schedules" ("employee_id", "date", "start_time")
  NULLS NOT DISTINCT;
