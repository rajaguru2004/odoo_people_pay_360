-- Government identifier categories for EmployeeLegalDocument.
--
-- Its own header prescribes this: "future categories (PASSPORT, WORK_PERMIT,
-- EMIRATES_ID, ...) are new enum values, not new tables."
--
-- Needed because Employee.idCard is NOT a real government identifier — the
-- onboarding stepper unconditionally sets idCard = employeeCode, and the service
-- skips the uniqueness check when auto-generating, so for every employee created
-- through the UI it holds an internal code. A wage file that puts that in the
-- national-ID column is rejected by the ministry.
--
-- EmployeeLegalDocument already provides everything an identifier needs:
-- documentNumber, country, issue/expiry dates, a partial unique index on
-- is_current (exactly one live identifier per category), the renewal chain, and
-- the existing expiry-alert cron — so labour-card expiry reminders come free.
--
-- All nine land in one migration: countries #2-#5 then need no schema work.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block, which is why
-- this is its own migration file with nothing else in it.

ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'LABOUR_CARD';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'CIVIL_ID';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'NATIONAL_ID';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'WORK_PERMIT';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'PASSPORT';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'EMIRATES_ID';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'IQAMA';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'QID';
ALTER TYPE "LegalDocumentCategory" ADD VALUE IF NOT EXISTS 'CPR';
