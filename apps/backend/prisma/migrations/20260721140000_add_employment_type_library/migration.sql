-- Dedicated Employment Type library (separate from Contract Types). Employment
-- type drives Overtime Policy resolution and is admin-configured here.
-- NOTE: ALTER TYPE ... ADD VALUE must run outside a transaction and cannot be
-- used in the same transaction it is added, so this migration only adds the
-- enum value. Seed the default options separately afterwards via the Libraries
-- "Seed Defaults" action (LibraryItemsService.seedDefaults() — includes
-- EMPLOYMENT_TYPE: Monthly, Daily Wage, Contract).
ALTER TYPE "LibraryType" ADD VALUE IF NOT EXISTS 'EMPLOYMENT_TYPE';
