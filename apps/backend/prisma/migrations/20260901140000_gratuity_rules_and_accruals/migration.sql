-- End-of-service benefits: the rule table and the monthly provision ledger.
--
-- Why this exists at all: `payroll_gratuity_enabled` and `payroll_gratuity_rate`
-- have shipped for a long time, the Oman and UAE country presets both set the
-- flag to 'true', and NOTHING in the engine has ever read either of them. An
-- Oman installation today shows gratuity switched on, at a plausible rate, and
-- computes nothing. That is a correctness problem with legal exposure, not a
-- missing feature.
--
-- Everything here is inert until `payroll_eosb_enabled` is turned on, and that
-- is a NEW key rather than the existing `payroll_gratuity_enabled` precisely
-- because the presets already set the old one — reusing it would switch the
-- feature live on deploy for the customers who must least be surprised by it.

-- ── Nationality ────────────────────────────────────────────────────────────
--
-- The existing free-text `nationality` column is untouched: it defaults to
-- 'Vietnam', it is displayed in places this change must not alter, and a free
-- string cannot drive a statutory rule anyway.
ALTER TABLE "employee_profiles"
  ADD COLUMN "nationality_code"  VARCHAR(2),
  ADD COLUMN "nationality_class" VARCHAR(20);

-- Uppercase ISO-3166 alpha-2, because that is what every other country-scoped
-- table in this system keys on (`banks.country`, `country_banking_fields`). A
-- lowercase or three-letter code would silently match no rule at all, and the
-- employee would fall out of every country-scoped calculation without an error.
ALTER TABLE "employee_profiles"
  ADD CONSTRAINT "employee_profile_nationality_code_iso"
  CHECK ("nationality_code" IS NULL OR "nationality_code" ~ '^[A-Z]{2}$');

ALTER TABLE "employee_profiles"
  ADD CONSTRAINT "employee_profile_nationality_class_known"
  CHECK ("nationality_class" IS NULL
         OR "nationality_class" IN ('NATIONAL', 'GCC', 'EXPAT'));

-- ── Rules ──────────────────────────────────────────────────────────────────
CREATE TABLE "gratuity_rules" (
  "id"                UUID          NOT NULL DEFAULT gen_random_uuid(),
  "country"           VARCHAR(2)    NOT NULL,
  "nationality_class" VARCHAR(20)   NOT NULL,
  "from_years"        DECIMAL(6,3)  NOT NULL,
  "to_years"          DECIMAL(6,3),
  "days_per_year"     DECIMAL(6,3)  NOT NULL,
  "basis"             VARCHAR(10)   NOT NULL DEFAULT 'BASIC',
  "month_days"        DECIMAL(6,3)  NOT NULL DEFAULT 30,
  "employer_share"    DECIMAL(5,4)  NOT NULL DEFAULT 1,
  "effective_from"    DATE          NOT NULL,
  "effective_to"      DATE,
  "is_active"         BOOLEAN       NOT NULL DEFAULT true,
  "notes"             TEXT,
  "created_at"        TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gratuity_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gratuity_rules_lookup_idx"
  ON "gratuity_rules"("country", "nationality_class", "effective_from");

-- The resolver switches on this. An unrecognised class matches no rule and
-- therefore yields a ZERO entitlement — a failure in the direction of
-- underpaying a statutory benefit, which is the direction that ends in a claim.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_class_known"
  CHECK ("nationality_class" IN ('NATIONAL', 'GCC', 'EXPAT', 'ANY'));

-- Basic vs gross is roughly a 2.5x difference in a Gulf salary structure.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_basis_known"
  CHECK ("basis" IN ('BASIC', 'GROSS'));

-- A band that ends before it starts matches no service length, so the ladder
-- silently loses a rung and long-serving staff quietly accrue nothing.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_band_ordered"
  CHECK ("to_years" IS NULL OR "to_years" > "from_years");

-- A negative accrual would REDUCE a liability.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_amounts_non_negative"
  CHECK ("days_per_year" >= 0 AND "from_years" >= 0);

-- It is a divisor.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_month_days_positive"
  CHECK ("month_days" > 0);

-- Above 1 over-provisions; below 0 would net one employee's benefit off against
-- another's.
ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_employer_share_fraction"
  CHECK ("employer_share" >= 0 AND "employer_share" <= 1);

ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_dates_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- The constraint that actually matters.
--
-- Two overlapping ACTIVE rules make an entitlement non-deterministic: which one
-- applies depends on row order, so the same employee can be quoted two different
-- figures. And it does not fail when the second rule is added — it fails years
-- later, when someone with enough service to reach the overlap finally leaves.
-- A sort order in the service layer cannot prevent it; a database constraint can.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "gratuity_rules"
  ADD CONSTRAINT "gratuity_rule_no_overlap"
  EXCLUDE USING gist (
    "country" WITH =,
    "nationality_class" WITH =,
    numrange("from_years", COALESCE("to_years", 'Infinity'::numeric), '[)') WITH &&,
    daterange("effective_from", COALESCE("effective_to", 'infinity'::date), '[)') WITH &&
  ) WHERE ("is_active");

-- ── Accruals ───────────────────────────────────────────────────────────────
CREATE TABLE "gratuity_accruals" (
  "id"             UUID          NOT NULL DEFAULT gen_random_uuid(),
  "employee_id"    UUID          NOT NULL,
  "branch_id"      UUID          NOT NULL,
  "payroll_id"     UUID          NOT NULL,
  "month"          INTEGER       NOT NULL,
  "year"           INTEGER       NOT NULL,
  "basis_amount"   DECIMAL(12,2) NOT NULL,
  "service_years"  DECIMAL(8,4)  NOT NULL,
  "days_accrued"   DECIMAL(8,4)  NOT NULL,
  "amount"         DECIMAL(12,2) NOT NULL,
  "employer_share" DECIMAL(5,4)  NOT NULL,
  "rule_id"        UUID,
  "working_json"   JSONB         NOT NULL,
  "status"         VARCHAR(20)   NOT NULL DEFAULT 'ACCRUED',
  "reversed_at"    TIMESTAMP(6),
  "settlement_id"  UUID,
  "created_at"     TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gratuity_accruals_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accruals_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accruals_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "gratuity_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- What makes lock -> unlock -> lock safe. A second accrual for the same run
-- cannot be inserted, so a reversal that is later re-applied cannot double the
-- liability.
CREATE UNIQUE INDEX "uniq_gratuity_accrual_employee_payroll"
  ON "gratuity_accruals"("employee_id", "payroll_id");

CREATE INDEX "gratuity_accruals_employee_period_idx"
  ON "gratuity_accruals"("employee_id", "year", "month");
CREATE INDEX "gratuity_accruals_branch_period_idx"
  ON "gratuity_accruals"("branch_id", "year", "month");

ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accrual_status_known"
  CHECK ("status" IN ('ACCRUED', 'REVERSED', 'SETTLED'));

ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accrual_amounts_non_negative"
  CHECK ("amount" >= 0 AND "service_years" >= 0 AND "days_accrued" >= 0);

ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accrual_share_fraction"
  CHECK ("employer_share" >= 0 AND "employer_share" <= 1);

-- An accrual with no working cannot be defended in a dispute, and defending it
-- in a dispute is the entire reason the ledger exists.
ALTER TABLE "gratuity_accruals"
  ADD CONSTRAINT "gratuity_accrual_working_present"
  CHECK (jsonb_typeof("working_json") = 'object');

-- ── The one seeded rule ────────────────────────────────────────────────────
--
-- Oman, expatriate, whole service, 30 days of basic per year, from the date the
-- 2023 labour law took effect.
--
-- NOTE the deliberate divergence from `payroll_gratuity_rate`. That setting has
-- shipped as 0.0822, documented in the preset as "30/365" — which prices a day
-- as ANNUAL basic / 365. This rule prices a day the standard Gulf way, monthly
-- basic / 30, so a year earns exactly one month's basic: 0.0833, about 1.4%
-- higher. Taking the divergence is safe because that setting has never been
-- read by any code — there is no behaviour to preserve, only a number that was
-- displayed on a configuration screen.
--
-- Which convention Oman actually requires is a question for a local advisor.
-- `month_days` is the single field that expresses it: setting it to 365/12
-- (30.4167) reproduces 0.0822 exactly, with no code change and no migration.
--
-- Deliberately ONE row. The pre-2023 band and the Social Protection Fund split
-- for Omani nationals are both expressible here without a migration, and both
-- need a local legal advisor to confirm before they are written.
INSERT INTO "gratuity_rules" (
  "country", "nationality_class", "from_years", "to_years",
  "days_per_year", "basis", "month_days", "employer_share",
  "effective_from", "notes"
) VALUES (
  'OM', 'EXPAT', 0, NULL,
  30, 'BASIC', 30, 1,
  DATE '2023-07-26',
  'Oman Labour Law 2023: 30 days basic per year of service, employer-borne. '
  'Seeded as the single starting rule; pre-2023 bands and the Social Protection '
  'Fund treatment of Omani nationals are added as further rows once confirmed.'
);
