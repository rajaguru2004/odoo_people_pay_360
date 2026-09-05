-- Employee grades.
--
-- `docs/PAYROLL-GAP-REPORT.md` §8 lists grade as "renamed — Employee.employmentType".
-- It is not a rename here, and deliberately so: `employmentType` is a
-- CONTRACT_TYPE library label that drives the overtime-policy inheritance chain,
-- so repurposing it would change overtime for every employee in the system.
--
-- Grade is a NEW nullable axis. With the feature off, `grade_id` is null
-- everywhere and nothing reads these tables.

CREATE TABLE "grades" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "code"        VARCHAR(20)   NOT NULL,
  "name"        VARCHAR(100)  NOT NULL,
  "level"       INTEGER       NOT NULL,
  "min_salary"  DECIMAL(12,2),
  "max_salary"  DECIMAL(12,2),
  "branch_id"   UUID,
  "description" TEXT,
  "is_active"   BOOLEAN       NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grades_code_key" ON "grades"("code");
CREATE INDEX "grades_level_idx" ON "grades"("level");

ALTER TABLE "grades"
  ADD CONSTRAINT "grade_level_positive"
  CHECK ("level" > 0);

-- A band whose ceiling is below its floor makes EVERY salary out of range, so
-- the eligibility check would reject every employee at that grade.
ALTER TABLE "grades"
  ADD CONSTRAINT "grade_salary_band_ordered"
  CHECK ("min_salary" IS NULL OR "max_salary" IS NULL OR "max_salary" >= "min_salary");

ALTER TABLE "grades"
  ADD CONSTRAINT "grade_salary_non_negative"
  CHECK (("min_salary" IS NULL OR "min_salary" >= 0)
         AND ("max_salary" IS NULL OR "max_salary" >= 0));

CREATE TABLE "grade_salary_components" (
  "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
  "grade_id"       UUID          NOT NULL,
  "component_type" VARCHAR(50)   NOT NULL,
  "value_type"     VARCHAR(20)   NOT NULL,
  "value"          DECIMAL(12,4) NOT NULL,
  "is_mandatory"   BOOLEAN       NOT NULL DEFAULT false,

  CONSTRAINT "grade_salary_components_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "grade_salary_components"
  ADD CONSTRAINT "grade_salary_components_grade_id_fkey"
  FOREIGN KEY ("grade_id") REFERENCES "grades"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One rule per component type per grade. Two would make the template's output
-- depend on row order.
CREATE UNIQUE INDEX "uniq_grade_component"
  ON "grade_salary_components"("grade_id", "component_type");

ALTER TABLE "grade_salary_components"
  ADD CONSTRAINT "grade_component_value_type_known"
  CHECK ("value_type" IN ('FIXED', 'PERCENT_OF_BASIC'));

ALTER TABLE "grade_salary_components"
  ADD CONSTRAINT "grade_component_value_non_negative"
  CHECK ("value" >= 0);

-- A percentage above 1000 is a typo, not a policy — most often a rate entered as
-- basis points, which would multiply somebody's allowance by a hundred.
ALTER TABLE "grade_salary_components"
  ADD CONSTRAINT "grade_component_percent_in_range"
  CHECK ("value_type" <> 'PERCENT_OF_BASIC' OR ("value" > 0 AND "value" <= 1000));

-- Nullable, and SetNull on delete: retiring a grade must not delete employees.
ALTER TABLE "employees" ADD COLUMN "grade_id" UUID;

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_grade_id_fkey"
  FOREIGN KEY ("grade_id") REFERENCES "grades"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "employees_grade_id_idx" ON "employees"("grade_id");
