-- Employee nationality on each visa record (ISO-3166 alpha-2), for nationality-based
-- reporting/segregation. Nullable: pre-existing visa rows have no value.
ALTER TABLE "employee_legal_documents"
  ADD COLUMN IF NOT EXISTS "nationality" VARCHAR(2);
