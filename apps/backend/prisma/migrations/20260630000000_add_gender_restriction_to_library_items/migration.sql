-- AlterTable: add gender_restriction column to library_items
ALTER TABLE "library_items" ADD COLUMN "gender_restriction" VARCHAR(10);

-- Update existing Maternity Leave and Paternity Leave records
UPDATE "library_items"
SET "gender_restriction" = 'FEMALE'
WHERE "library_type" = 'LEAVE_TYPE' AND "label" = 'Maternity Leave';

UPDATE "library_items"
SET "gender_restriction" = 'MALE'
WHERE "library_type" = 'LEAVE_TYPE' AND "label" = 'Paternity Leave';
