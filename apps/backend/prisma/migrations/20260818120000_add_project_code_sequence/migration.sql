-- Project codes come from a SEQUENCE, not from parsing the lexical maximum.
--
-- WHY (finding R6 / plan §5.5 F11)
--
-- `ProjectsService.generateProjectCode()` used to read the LEXICALLY largest
-- `project_code` in the whole table and do
--     parseInt(code.replace('PROJ-', ''), 10) + 1
-- which assumes every row matches `PROJ-<digits>`. Any code whose first letter
-- sorts above 'P' — an imported code, a hand-assigned one, or the `WP…` codes
-- the workplace e2e fixtures seed — becomes that maximum, the parse yields NaN
-- and the generator emits the literal string 'PROJ-0NaN'. `project_code` is
-- UNIQUE, so exactly one row can hold it: the first create returns 201 with a
-- nonsense code and EVERY subsequent create in that database answers 500 until
-- somebody deletes the row. Permanent, silent, and reachable in production.
--
-- A sequence cannot be poisoned by another row's format and, unlike any
-- read-then-write MAX(), is atomic under concurrency. This is the same
-- mechanism letter serials already use (`letter_serial_seq`, added in
-- 20260803170000_add_letters_grievance_vault).
CREATE SEQUENCE IF NOT EXISTS "project_code_seq" START 1;

-- Seed it past whatever well-formed codes the database already holds, so the
-- first minted code cannot collide with an existing row. Only when the sequence
-- has never been read (last_value IS NULL), so re-running this can never rewind
-- a live sequence beneath codes it has already issued.
DO $$
DECLARE
  already_used boolean;
  start_at     bigint;
BEGIN
  SELECT last_value IS NOT NULL
    INTO already_used
    FROM pg_sequences
   WHERE schemaname = 'public' AND sequencename = 'project_code_seq';

  IF already_used IS NOT NULL AND NOT already_used THEN
    SELECT COALESCE(MAX(CAST(substring(project_code FROM 6) AS BIGINT)), 0) + 1
      INTO start_at
      FROM projects
     WHERE project_code ~ '^PROJ-[0-9]+$';

    PERFORM setval('project_code_seq', GREATEST(start_at, 1), false);
  END IF;
END $$;
