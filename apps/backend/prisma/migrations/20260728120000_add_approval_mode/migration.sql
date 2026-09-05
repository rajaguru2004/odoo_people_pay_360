-- Activation mode for a configurable approval chain.
--   SEQUENTIAL: step N+1 only becomes actionable after step N's approver accepts
--   PARALLEL:   every step is actionable at once; all must approve
-- Existing chains keep today's behavior via the SEQUENTIAL default.
CREATE TYPE "ApprovalMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

ALTER TABLE "approval_workflows"
  ADD COLUMN "mode" "ApprovalMode" NOT NULL DEFAULT 'SEQUENTIAL';
