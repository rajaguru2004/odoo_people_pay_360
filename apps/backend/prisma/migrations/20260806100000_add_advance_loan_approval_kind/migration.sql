-- Loan & Advances v2 — step A of 3.
--
-- This file contains EXACTLY ONE statement, on purpose.
--
-- `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that later
-- references the new value, so the enum member has to land in its own migration
-- ahead of anything that uses it. The v2 schema migration is timestamped after
-- this one (20260806110000) and may then reference 'ADVANCE_LOAN' freely.
--
-- Same pattern as 20260803140000_add_travel_management.

ALTER TYPE "ApprovalRequestType" ADD VALUE IF NOT EXISTS 'ADVANCE_LOAN';
