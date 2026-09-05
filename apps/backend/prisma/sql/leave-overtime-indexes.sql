-- Partial unique indexes Prisma cannot express.
--
-- `@@unique` in Prisma is unconditional, and both rules below are conditional on
-- `is_active`. Expressed as a plain unique constraint they would forbid keeping
-- a deactivated policy alongside its replacement — which is the normal way an
-- administrator changes overtime rules without destroying the record of what the
-- old ones were.
--
-- Run after `npm run db:push`:
--   npx prisma db execute --file prisma/sql/leave-overtime-indexes.sql --schema prisma/schema.prisma
--
-- Idempotent: safe to re-run after every push, and `db push` drops indexes it
-- does not know about, so re-running it IS the maintenance procedure.

-- Exactly one active company-default policy.
--
-- Without it, two rows can both claim the default and `findFirst` picks by
-- whatever order the planner happens to use — so the same employee resolves to
-- different overtime rates on different requests, and nothing in the data says
-- which answer was right.
CREATE UNIQUE INDEX IF NOT EXISTS overtime_policies_one_active_default
  ON overtime_policies (is_default)
  WHERE is_default = true AND is_active = true;

-- At most one active policy per employment type, for the same reason: the middle
-- tier of the inheritance chain has to resolve to one row or it resolves to
-- whichever row the database happened to return first.
CREATE UNIQUE INDEX IF NOT EXISTS overtime_policies_one_active_per_emptype
  ON overtime_policies (employment_type)
  WHERE employment_type IS NOT NULL AND is_active = true;
