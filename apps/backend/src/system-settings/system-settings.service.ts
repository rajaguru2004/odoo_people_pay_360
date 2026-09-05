import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { companyTzCache } from '../common/timezone/timezone-cache';
import { isProtectedSettingKey } from './protected-setting-keys';
import {
  MAIL_SETTING_KEYS,
  MailConfig,
  resolveMailConfig,
} from './mail-settings';
import {
  DEFAULT_START_DATE_POLICY,
  StartDatePolicy,
  parseDateOnlyUTC,
} from '../common/utils/start-date-policy.util';

// ── Setting value shapes ──────────────────────────────────────────────────────
//
// `updateSettings()` upserts ARBITRARY keys on purpose — other modules park
// their own configuration here and nothing enumerates the namespace — so the
// table below is an allow-list of the keys whose SHAPE is known, never a gate
// on which keys may be written. A key absent from it is stored exactly as
// before.
//
// The hole this closes: every reader coerces at use time and falls back
// silently. `LoanPolicyService.oneOf()` meets `loan_shortfall_policy: 'BANANA'`
// and quietly uses PARTIAL; `num()` meets 'not-a-number' and quietly uses the
// default. The settings screen then shows BANANA while payroll runs PARTIAL,
// with nothing anywhere reporting the divergence. Two of those fallbacks are
// worse than cosmetic: a negative `loan_min_net_pay_percent` normalises to NO
// take-home floor and `loan_max_total_deduction_percent_of_net: 500` lifts the
// deduction cap entirely — both silently remove a protection on an employee's
// pay, at the moment an administrator believes they tightened it.
//
// So: a value that will be DISCARDED at read time is REFUSED at write time,
// with a message naming the key and what it accepts.

/** The four RBAC roles a role-list setting may name (`User.role`). */
const SETTING_ROLE_VALUES = [
  'ADMIN',
  'HR_MANAGER',
  'MANAGER',
  'EMPLOYEE',
] as const;

/**
 * A declared shape for one setting value.
 *
 * Deliberately data, not a switch: §12's fix has to cover ~40 keys, and a
 * switch would have grown one arm per key and drifted from the registry the
 * moment somebody added a setting.
 */
export type SettingValueRule =
  /** Exactly one of `values`, matched case-insensitively and stored upper-cased. */
  | { kind: 'enum'; values: readonly string[] }
  /** Literally 'true' or 'false' — every reader compares `=== 'true'`. */
  | { kind: 'boolean' }
  /** A finite number, optionally bounded and/or whole. */
  | {
      kind: 'number';
      min?: number;
      max?: number;
      /** True => `min` is exclusive (e.g. a rounding unit must be > 0). */
      exclusiveMin?: boolean;
      integer?: boolean;
    }
  /** Comma-separated subset of `values`; blank clears back to the default. */
  | { kind: 'enumList'; values: readonly string[] }
  /** Comma-separated RBAC roles. Blank = nobody, which is a legitimate setting. */
  | { kind: 'roles' }
  /** Comma-separated user UUIDs. Blank = nobody. */
  | { kind: 'uuidList' };

/** Convenience: a percentage of pay, where anything outside 0–100 is nonsense. */
const PERCENT: SettingValueRule = { kind: 'number', min: 0, max: 100 };
/** Convenience: money/counters that cannot meaningfully go negative. */
const NON_NEGATIVE: SettingValueRule = { kind: 'number', min: 0 };
const NON_NEGATIVE_INT: SettingValueRule = {
  kind: 'number',
  min: 0,
  integer: true,
};

/**
 * Known value shapes, keyed by setting key.
 *
 * Scoped to the loans & advances family — the settings whose silent fallbacks
 * §12 documents, and the ones the E2E suite flips.
 *
 * `loan_grace_mode` and `loan_default_frequency` used to be absent because no
 * allow-list for them was established anywhere: the keys were seeded and read
 * by nothing, so guessing one would have refused values that nothing had ever
 * rejected. They have readers now, and those readers write the value straight
 * into an enum column — an unconstrained key would be accepted here and then
 * fail at the far end of a loan application, so the constraint is the column's
 * own enum rather than an invention.
 *
 * `loan_reference_prefix` stays absent, and not by oversight: it is free text
 * that only ever prefixes a generated string, there is no set of values it
 * could be wrong against, and the rule kinds here are all membership tests.
 */
export const SETTING_VALUE_RULES: Readonly<Record<string, SettingValueRule>> = {
  // ── Enumerations (the `oneOf()` readers) ────────────────────────────────
  loan_shortfall_policy: { kind: 'enum', values: ['PARTIAL', 'DEFER', 'SKIP'] },
  loan_deferral_mode: {
    kind: 'enum',
    values: ['CARRY_FORWARD', 'EXTEND_TENURE'],
  },
  loan_zero_salary_policy: { kind: 'enum', values: ['DEFER', 'SKIP'] },
  loan_unpaid_leave_policy: {
    kind: 'enum',
    values: ['CONTINUE', 'PAUSE', 'EXTEND'],
  },
  loan_priority_tiebreak: {
    kind: 'enum',
    values: ['OLDEST_FIRST', 'SMALLEST_BALANCE_FIRST'],
  },
  loan_payment_allocation_order: {
    kind: 'enum',
    values: ['INTEREST_FIRST', 'PRINCIPAL_FIRST'],
  },
  loan_recovery_failure_policy: { kind: 'enum', values: ['FAIL', 'WARN'] },
  loan_prepayment_mode: {
    kind: 'enum',
    values: ['REDUCE_TENURE', 'REDUCE_EMI'],
  },
  // Mirrors the LoanInterestMethod enum the column is typed with, so a default
  // that could never be persisted on a loan cannot be configured either.
  loan_default_interest_method: {
    kind: 'enum',
    values: ['NONE', 'FLAT', 'REDUCING_BALANCE'],
  },
  loan_flat_prepayment_interest: {
    kind: 'enum',
    values: ['FULL', 'PRORATA', 'NONE'],
  },
  loan_topup_mode: { kind: 'enum', values: ['NEW_LOAN', 'IN_PLACE'] },
  // Mirrors LoanDeductionFrequency. BIWEEKLY is not in it: the amortisation
  // engine has no periods-per-year for it, so offering it here would build a
  // schedule against a frequency nothing can price.
  loan_default_frequency: {
    kind: 'enum',
    values: ['MONTHLY', 'WEEKLY', 'QUARTERLY'],
  },
  // Mirrors LoanGraceMode.
  loan_grace_mode: {
    kind: 'enum',
    values: ['NONE', 'MORATORIUM_FULL', 'MORATORIUM_INTEREST_ONLY'],
  },

  // ── Kill switches and flags ─────────────────────────────────────────────
  // Document engine. Every one of these defaults OFF: a customer already live
  // on the product must not have their letters change shape on an upgrade
  // nobody asked for.
  document_engine_enabled: { kind: 'boolean' },
  document_visual_editor_enabled: { kind: 'boolean' },
  document_live_preview_enabled: { kind: 'boolean' },
  document_bulk_enabled: { kind: 'boolean' },
  document_bulk_generate_roles: { kind: 'roles' },
  document_bulk_max_items: { kind: 'number', min: 1, max: 2000, integer: true },
  document_bulk_merge_max: { kind: 'number', min: 1, max: 500, integer: true },
  document_render_concurrency: { kind: 'number', min: 1, max: 8, integer: true },
  document_browser_recycle_renders: { kind: 'number', min: 10, max: 5000, integer: true },
  document_batch_stale_minutes: { kind: 'number', min: 5, max: 240, integer: true },
  advance_loan_enabled: { kind: 'boolean' },
  loan_module_v2_enabled: { kind: 'boolean' },
  loan_interest_enabled: { kind: 'boolean' },
  loan_final_settlement_ignores_min_net: { kind: 'boolean' },
  loan_auto_close_on_full_recovery: { kind: 'boolean' },
  loan_clearance_blocking_enabled: { kind: 'boolean' },
  loan_restructure_requires_approval: { kind: 'boolean' },
  loan_topup_enabled: { kind: 'boolean' },
  loan_employee_self_prepay: { kind: 'boolean' },

  // ── Percentages of pay ──────────────────────────────────────────────────
  // A floor below 0% is no floor; a cap above 100% is no cap. Both read back
  // as "protection configured" while protecting nothing.
  loan_min_net_pay_percent: PERCENT,
  loan_security_deposit_percent: PERCENT,
  loan_max_total_deduction_percent_of_net: PERCENT,
  loan_max_emi_percent_of_net: PERCENT,

  // ── Money and counters ──────────────────────────────────────────────────
  loan_min_net_pay_amount: NON_NEGATIVE,
  loan_min_partial_recovery_amount: NON_NEGATIVE,
  loan_rounding_tolerance: NON_NEGATIVE,
  loan_min_emi_amount: NON_NEGATIVE,
  loan_max_amount_multiple_of_salary: NON_NEGATIVE, // 0 = unlimited
  // An annual rate is uncapped on purpose: jurisdictions differ and there is no
  // read-time fallback that a high rate would silently trigger.
  loan_default_interest_rate: NON_NEGATIVE,
  // `roundingUnit()` rejects <= 0 at read time and uses 0.01, so 0 must not be
  // storable — it would look like "no rounding" and behave like cents.
  loan_rounding_unit: { kind: 'number', min: 0, exclusiveMin: true },
  loan_grace_period_cycles: NON_NEGATIVE_INT,
  loan_unpaid_leave_min_days: NON_NEGATIVE_INT,
  loan_max_active_per_employee: NON_NEGATIVE_INT, // 0 = nobody may borrow
  loan_min_service_months: NON_NEGATIVE_INT,
  loan_overdue_after_cycles: NON_NEGATIVE_INT,
  advance_loan_allow_backdated_days: NON_NEGATIVE_INT,
  // A ceiling of zero instalments would make every loan unapprovable.
  advance_loan_max_installments: { kind: 'number', min: 1, integer: true },
  // Not capped at 100: an advance of more than one month's pay is a policy
  // choice, not a discarded value.
  advance_max_percent_of_salary: NON_NEGATIVE,

  // ── Ordering lists ──────────────────────────────────────────────────────
  loan_recovery_priority_order: {
    kind: 'enumList',
    values: ['ADVANCE', 'LOAN'],
  },
  loan_recover_on_run_types: {
    kind: 'enumList',
    values: ['REGULAR', 'OFF_CYCLE', 'BONUS', 'ADJUSTMENT', 'FINAL_SETTLEMENT'],
  },

  // ── Access lists ────────────────────────────────────────────────────────
  advance_loan_approver_roles: { kind: 'roles' },
  advance_loan_finance_roles: { kind: 'roles' },
  advance_loan_auditor_roles: { kind: 'roles' },
  advance_loan_writeoff_roles: { kind: 'roles' },
  loan_waiver_roles: { kind: 'roles' },
  advance_loan_auditor_user_ids: { kind: 'uuidList' },

  // ── Payroll extensions ──────────────────────────────────────────────────
  //
  // NEW keys only. Adding a rule to an EXISTING key changes its write path —
  // a `boolean` rule turns a blank write from "store ''" into "clear the row" —
  // so `payroll_gratuity_enabled` and friends are deliberately absent here.
  payroll_item_lines_enabled: { kind: 'boolean' },
  payroll_item_lines_strict_reconciliation: { kind: 'boolean' },
  payroll_eosb_enabled: { kind: 'boolean' },
  payroll_eosb_accrual_enabled: { kind: 'boolean' },
  payroll_eosb_settlement_enabled: { kind: 'boolean' },
  payroll_eosb_unknown_nationality_policy: {
    kind: 'enum',
    values: ['BLOCK', 'SKIP'],
  },
  payroll_eosb_service_year_days: {
    kind: 'number',
    min: 1,
    integer: true,
  },
  leave_encashment_enabled: { kind: 'boolean' },
  leave_encashment_taxable: { kind: 'boolean' },
  payroll_eosb_pay_through_final_run: { kind: 'boolean' },
  leave_carry_forward_enabled: { kind: 'boolean' },
  payroll_calendar_enabled: { kind: 'boolean' },
  payroll_cutoff_enforcement: { kind: 'enum', values: ['WARN', 'BLOCK'] },
  payroll_preflight_enabled: { kind: 'boolean' },
  payroll_employee_recovery_enabled: { kind: 'boolean' },
  payroll_recovery_ladder_position: {
    kind: 'enum',
    values: ['AFTER_LOAN', 'BEFORE_LOAN'],
  },
  payroll_recovery_respects_min_net: { kind: 'boolean' },
  employee_transfer_enabled: { kind: 'boolean' },
  payroll_transfer_pay_basis: {
    kind: 'enum',
    values: ['PERIOD_END', 'CUT_OFF'],
  },
  employee_grade_enabled: { kind: 'boolean' },
  demo_autoseed_enabled: { kind: 'boolean' },
  demo_autoseed_include_offdays: { kind: 'boolean' },
  payroll_reports_enabled: { kind: 'boolean' },

  // ── Overtime approver review & edit ─────────────────────────────────────
  overtime_approver_edit_enabled: { kind: 'boolean' },
  overtime_site_allowance_enabled: { kind: 'boolean' },
  // 0 is not "no allowance allowed" but "no ceiling" — the same convention
  // loan_max_amount_multiple_of_salary uses, so an admin who wants the feature
  // uncapped does not have to invent a large number.
  overtime_site_allowance_max: NON_NEGATIVE,
};

/** Human-readable half of the refusal message: what the key accepts. */
function describeSettingRule(rule: SettingValueRule): string {
  switch (rule.kind) {
    case 'enum':
      return `one of ${rule.values.join(', ')}`;
    case 'boolean':
      return '"true" or "false"';
    case 'number': {
      const noun = rule.integer ? 'a whole number' : 'a number';
      const lower =
        rule.min === undefined
          ? null
          : rule.exclusiveMin
            ? `greater than ${rule.min}`
            : `${rule.min} or more`;
      const upper = rule.max === undefined ? null : `at most ${rule.max}`;
      const bounds = [lower, upper].filter(Boolean).join(' and ');
      return bounds ? `${noun} ${bounds}` : noun;
    }
    case 'enumList':
      return `a comma-separated list of ${rule.values.join(', ')}`;
    case 'roles':
      return `a comma-separated list of roles (${SETTING_ROLE_VALUES.join(', ')}), or blank for none`;
    case 'uuidList':
      return 'a comma-separated list of user IDs (UUIDs), or blank for none';
  }
}

/** Splits a comma-separated setting value into trimmed, non-empty entries. */
const settingListParts = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a write to one setting should DO.
 *
 * Three outcomes, because "blank" is a third thing and not a validation
 * failure. An administrator who clears an optional numeric field is expressing
 * an intent — "no override here" — and that intent worked before this
 * validation existed; refusing the whole payload for it would be a worse
 * experience than the bug §12 set out to fix. So a blank on a key with a real
 * engine default CLEARS the stored override instead of storing an empty string
 * that every reader would coerce back to that default anyway.
 *
 * Blank keeps its existing meaning on the access lists, where it already means
 * "nobody" rather than "the default": clearing `advance_loan_approver_roles`
 * has to mean no role may approve, not the shipped HR_MANAGER,ADMIN.
 */
export type SettingWriteAction =
  /** No declared shape — store the caller's value verbatim, as before. */
  | { action: 'passthrough' }
  /** Store this normalised value. */
  | { action: 'store'; value: string }
  /** Delete the row, so `getSetting()` falls back to the engine default. */
  | { action: 'clear' };

/**
 * Validates one setting value against its declared shape and says what to do
 * with it. Enums and lists come back upper-cased, so `partial` is stored as the
 * PARTIAL the engine actually compares against.
 *
 * Throws `BadRequestException` naming the key and what it accepts — but only
 * for a value that is genuinely wrong ('BANANA', -10, 500, 'not-a-number').
 * Blank is an instruction, not a mistake: see `SettingWriteAction`.
 */
export function validateSettingValue(
  key: string,
  value: string,
): SettingWriteAction {
  const rule = SETTING_VALUE_RULES[key];
  // Unknown key: the write path stays open by design.
  if (!rule) return { action: 'passthrough' };

  const raw = value.trim();
  const reject = (): never => {
    throw new BadRequestException(
      `Invalid ${key}: expected ${describeSettingRule(rule)}, got "${value}"`,
    );
  };
  const store = (v: string): SettingWriteAction => ({
    action: 'store',
    value: v,
  });

  switch (rule.kind) {
    case 'enum': {
      // No loan enum has a meaning for blank — every one of them resolves
      // through `oneOf(..., fallback)` — so a cleared field reverts.
      if (raw === '') return { action: 'clear' };
      const up = raw.toUpperCase();
      if (!rule.values.includes(up)) reject();
      return store(up);
    }
    case 'boolean': {
      if (raw === '') return { action: 'clear' };
      const low = raw.toLowerCase();
      if (low !== 'true' && low !== 'false') reject();
      return store(low);
    }
    case 'number': {
      if (raw === '') return { action: 'clear' };
      const n = Number(raw);
      if (!Number.isFinite(n)) reject();
      if (rule.integer && !Number.isInteger(n)) reject();
      if (rule.min !== undefined) {
        if (rule.exclusiveMin ? n <= rule.min : n < rule.min) reject();
      }
      if (rule.max !== undefined && n > rule.max) reject();
      return store(raw);
    }
    case 'enumList': {
      // `LoanPolicyService.csv()` returns its fallback for an empty value, so
      // an empty list has never been a way of saying "recover nothing" — it is
      // the default wearing a disguise. Clear it and let the fallback show.
      if (raw === '') return { action: 'clear' };
      const parts = settingListParts(raw).map((s) => s.toUpperCase());
      if (parts.length === 0) return { action: 'clear' };
      if (parts.some((p) => !rule.values.includes(p))) reject();
      return store(parts.join(','));
    }
    case 'roles': {
      // Blank is MEANINGFUL here and is stored: it means nobody holds the
      // grant. Clearing the row instead would restore the shipped default and
      // hand the grant back to the roles the admin had just removed.
      const parts = settingListParts(raw).map((s) => s.toUpperCase());
      if (
        parts.some(
          (p) => !(SETTING_ROLE_VALUES as readonly string[]).includes(p),
        )
      ) {
        reject();
      }
      return store(parts.join(','));
    }
    case 'uuidList': {
      // Same as the role lists: blank means no named auditor, and is stored.
      const parts = settingListParts(raw);
      if (parts.some((p) => !UUID_RE.test(p))) reject();
      return store(parts.join(','));
    }
  }
}

/**
 * Per-country payroll presets, applied in bulk by `applyCountryPreset`.
 *
 * Lifted out of the method so a guard spec can assert what a preset does
 * NOT contain. A preset is a bulk write an admin triggers for unrelated
 * reasons — switching currency, say — so a feature flag appearing in one
 * would enable that feature as a side effect, invisibly.
 * See `system-settings-registry.spec.ts`.
 */
export const COUNTRY_PRESETS: Record<string, Record<string, string>> = {
  // ── India ─────────────────────────────────────────────────────────────
  IN: {
    payroll_country: 'IN',
    payroll_currency: 'INR',
    payroll_currency_symbol: '₹',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.5',
    payroll_basic_salary_percentage: '40',
    // EPF
    payroll_pf_enabled: 'true',
    payroll_pf_employee_rate: '0.12',
    payroll_pf_employer_rate: '0.12',
    payroll_pf_salary_cap: '15000',
    payroll_pf_on_full_salary: 'false',
    // Professional Tax (Karnataka slabs)
    payroll_professional_tax_enabled: 'true',
    payroll_professional_tax_slabs: JSON.stringify([
      { upTo: 10000, tax: 0 },
      { upTo: 15000, tax: 110 },
      { upTo: 20000, tax: 130 },
      { upTo: 25000, tax: 150 },
      { upTo: 999999999, tax: 200 },
    ]),
    // Income Tax — New Regime FY 2025-26
    payroll_tax_regime: 'new',
    payroll_standard_deduction: '75000',
    payroll_personal_deduction_monthly: '6250',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([
      { limit: 300000, rate: 0.0 },
      { limit: 700000, rate: 0.05 },
      { limit: 1000000, rate: 0.1 },
      { limit: 1200000, rate: 0.15 },
      { limit: 1500000, rate: 0.2 },
      { limit: 999999999, rate: 0.3 },
    ]),
    payroll_tax_rebate_enabled: 'true',
    payroll_tax_rebate_limit: '700000',
    payroll_cess_enabled: 'true',
    payroll_cess_rate: '0.04',
    // ESI
    payroll_esi_enabled: 'true',
    payroll_esi_employee_rate: '0.0075',
    payroll_esi_employer_rate: '0.0325',
    payroll_esi_salary_cap: '21000',
    // Gratuity
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0.0481',
  },

  // ── United States ────────────────────────────────────────────────────
  US: {
    payroll_country: 'US',
    payroll_currency: 'USD',
    payroll_currency_symbol: '$',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.5',
    payroll_basic_salary_percentage: '100',
    // Social Security (OASDI) + Medicare (employee share)
    payroll_pf_enabled: 'true',
    payroll_pf_employee_rate: '0.0765', // 6.2% SS + 1.45% Medicare
    payroll_pf_employer_rate: '0.0765',
    payroll_pf_salary_cap: '168600', // 2024 SS wage base (USD)
    payroll_pf_on_full_salary: 'false',
    // No professional tax
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Federal Income Tax — 2024 single filer brackets
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '14600', // 2024 standard deduction (USD)
    payroll_personal_deduction_monthly: '1217',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([
      { limit: 11600, rate: 0.1 },
      { limit: 47150, rate: 0.12 },
      { limit: 100525, rate: 0.22 },
      { limit: 191950, rate: 0.24 },
      { limit: 243725, rate: 0.32 },
      { limit: 609350, rate: 0.35 },
      { limit: 999999999, rate: 0.37 },
    ]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    // No ESI equivalent
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    // No statutory gratuity
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0',
  },

  // ── United Kingdom ───────────────────────────────────────────────────
  GB: {
    payroll_country: 'GB',
    payroll_currency: 'GBP',
    payroll_currency_symbol: '£',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.5',
    payroll_basic_salary_percentage: '100',
    // National Insurance (employee — Class 1) 2024/25
    payroll_pf_enabled: 'true',
    payroll_pf_employee_rate: '0.08',
    payroll_pf_employer_rate: '0.138',
    payroll_pf_salary_cap: '0', // No cap — rate reduces above UEL
    payroll_pf_on_full_salary: 'true',
    // No professional tax
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Income Tax 2024/25
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '12570', // Personal Allowance (£)
    payroll_personal_deduction_monthly: '1048',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([
      { limit: 12570, rate: 0.0 },
      { limit: 50270, rate: 0.2 },
      { limit: 125140, rate: 0.4 },
      { limit: 999999999, rate: 0.45 },
    ]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0',
  },

  // ── UAE ──────────────────────────────────────────────────────────────
  AE: {
    payroll_country: 'AE',
    payroll_currency: 'AED',
    payroll_currency_symbol: 'د.إ',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.25', // UAE labour law: 25% above regular
    payroll_basic_salary_percentage: '60',
    // GPSSA (UAE nationals only; expats have no PF obligation)
    payroll_pf_enabled: 'false',
    payroll_pf_employee_rate: '0.05',
    payroll_pf_employer_rate: '0.125',
    payroll_pf_salary_cap: '0',
    payroll_pf_on_full_salary: 'false',
    // No professional tax
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Zero income tax (UAE has no personal income tax)
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '0',
    payroll_personal_deduction_monthly: '0',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([{ limit: 999999999, rate: 0.0 }]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    // UAE Gratuity — mandatory under labour law (21 days × years for first 5 yrs)
    payroll_gratuity_enabled: 'true',
    payroll_gratuity_rate: '0.0577', // 21/365 ≈ 5.77% of annual basic per year
  },

  // ── Oman ─────────────────────────────────────────────────────────────
  OM: {
    payroll_country: 'OM',
    payroll_currency: 'OMR',
    payroll_currency_symbol: 'ر.ع.',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.25', // Oman Labour Law: min 25% above regular (day)
    payroll_basic_salary_percentage: '60',
    // PASI / Social Protection Fund (SPF) — Omani nationals only; expats exempt.
    // Employee 8% (7.5% old-age/disability/death + 0.5% job security);
    // Employer 14.5% total. Wage ceiling OMR 3,000/month.
    payroll_pf_enabled: 'false',
    payroll_pf_employee_rate: '0.08',
    payroll_pf_employer_rate: '0.145',
    payroll_pf_salary_cap: '3000',
    payroll_pf_on_full_salary: 'false',
    // No professional tax
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Zero income tax (Oman has no personal income tax as of 2026)
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '0',
    payroll_personal_deduction_monthly: '0',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([{ limit: 999999999, rate: 0.0 }]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    // Oman End-of-Service Gratuity — mandatory for expats (1 month basic × year)
    payroll_gratuity_enabled: 'true',
    payroll_gratuity_rate: '0.0822', // 30/365 ≈ 8.22% of annual basic per year
  },

  // ── Singapore ────────────────────────────────────────────────────────
  SG: {
    payroll_country: 'SG',
    payroll_currency: 'SGD',
    payroll_currency_symbol: 'S$',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.5',
    payroll_basic_salary_percentage: '100',
    // CPF (age ≤ 55, employee 20%, employer 17%)
    payroll_pf_enabled: 'true',
    payroll_pf_employee_rate: '0.20',
    payroll_pf_employer_rate: '0.17',
    payroll_pf_salary_cap: '6800', // 2024 Ordinary Wage ceiling (SGD/month)
    payroll_pf_on_full_salary: 'false',
    // No professional tax
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Resident income tax 2024
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '0',
    payroll_personal_deduction_monthly: '0',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([
      { limit: 20000, rate: 0.0 },
      { limit: 30000, rate: 0.02 },
      { limit: 40000, rate: 0.035 },
      { limit: 80000, rate: 0.07 },
      { limit: 120000, rate: 0.115 },
      { limit: 160000, rate: 0.15 },
      { limit: 200000, rate: 0.18 },
      { limit: 240000, rate: 0.19 },
      { limit: 280000, rate: 0.195 },
      { limit: 320000, rate: 0.2 },
      { limit: 999999999, rate: 0.22 },
    ]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0',
  },

  // ── Germany ──────────────────────────────────────────────────────────
  DE: {
    payroll_country: 'DE',
    payroll_currency: 'EUR',
    payroll_currency_symbol: '€',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.25',
    payroll_basic_salary_percentage: '100',
    // Social contributions (Rentenversicherung 9.3% + Krankenversicherung 7.3% + Pflegeversicherung 1.7% + Arbeitslosenversicherung 1.3%)
    payroll_pf_enabled: 'true',
    payroll_pf_employee_rate: '0.196', // total ~19.6% employee share
    payroll_pf_employer_rate: '0.196',
    payroll_pf_salary_cap: '7550', // Beitragsbemessungsgrenze West 2024 (€/month)
    payroll_pf_on_full_salary: 'false',
    // No professional tax (Kirchensteuer not included here)
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    // Income Tax — Einkommensteuer 2024 (Steuerklasse I simplified)
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '11604', // Grundfreibetrag 2024 (€)
    payroll_personal_deduction_monthly: '967',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([
      { limit: 11604, rate: 0.0 },
      { limit: 17005, rate: 0.14 },
      { limit: 66760, rate: 0.24 },
      { limit: 277825, rate: 0.42 },
      { limit: 999999999, rate: 0.45 },
    ]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    // Solidarity surcharge (Solidaritätszuschlag) — 5.5% of tax (simplified as cess)
    payroll_cess_enabled: 'true',
    payroll_cess_rate: '0.055',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0',
  },

  // ── Custom (blank slate) ─────────────────────────────────────────────
  CUSTOM: {
    payroll_country: 'CUSTOM',
    payroll_currency: '',
    payroll_currency_symbol: '',
    payroll_work_hours_per_day: '8',
    payroll_work_days_per_week: '5',
    payroll_overtime_rate: '1.5',
    payroll_basic_salary_percentage: '100',
    payroll_pf_enabled: 'false',
    payroll_pf_employee_rate: '0',
    payroll_pf_employer_rate: '0',
    payroll_pf_salary_cap: '0',
    payroll_pf_on_full_salary: 'false',
    payroll_professional_tax_enabled: 'false',
    payroll_professional_tax_slabs: JSON.stringify([]),
    payroll_tax_regime: 'progressive',
    payroll_standard_deduction: '0',
    payroll_personal_deduction_monthly: '0',
    payroll_tax_calculation_period: 'annual',
    payroll_tax_brackets: JSON.stringify([{ limit: 999999999, rate: 0.0 }]),
    payroll_tax_rebate_enabled: 'false',
    payroll_tax_rebate_limit: '0',
    payroll_cess_enabled: 'false',
    payroll_cess_rate: '0',
    payroll_esi_enabled: 'false',
    payroll_esi_employee_rate: '0',
    payroll_esi_employer_rate: '0',
    payroll_esi_salary_cap: '0',
    payroll_gratuity_enabled: 'false',
    payroll_gratuity_rate: '0',
  },
};

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);

  constructor(
    private prisma: PrismaService,
    private uploadService: UploadService,
  ) {}

  /**
   * Config tables preserved by a baseline reset. Everything else in the public
   * schema is truncated. `_prisma_migrations` MUST stay or the schema history is
   * lost; the rest are app configuration (not operational data) that the base
   * seed relies on and never creates itself.
   */
  private static readonly RESET_KEEP_TABLES = new Set<string>([
    '_prisma_migrations',
    'system_settings',
    'library_items',
    'holidays',
  ]);

  /** The three base accounts the reset always restores (mirrors prisma/seed.ts). */
  private static readonly BASE_ACCOUNTS = [
    {
      email: 'admin@company.com',
      fallbackPassword: 'Admin@123',
      role: 'ADMIN',
      employeeCode: 'ADM001',
      idCard: 'ID-ADMIN-001',
      fullName: 'System Admin',
      position: 'System Administrator',
      isGlobalBranchAccess: true,
    },
    {
      email: 'hr.manager@company.com',
      fallbackPassword: 'Password123!',
      role: 'HR_MANAGER',
      employeeCode: 'HRM001',
      idCard: 'ID-HR-001',
      fullName: 'HR Manager',
      position: 'HR Manager',
      isGlobalBranchAccess: false,
    },
    {
      email: 'employee1@company.com',
      fallbackPassword: 'Password123!',
      role: 'EMPLOYEE',
      employeeCode: 'EMP001',
      idCard: 'ID-EMP-001',
      fullName: 'John Employee',
      position: 'Software Developer',
      isGlobalBranchAccess: false,
    },
  ] as const;

  /**
   * DESTRUCTIVE: reset the database to the base-seed baseline.
   *
   * Wipes every operational table (all except the config tables above), then
   * recreates the HRD department, an ACTIVE Head Office branch and the three
   * base accounts — preserving each base account's current password so admins
   * are not locked out.
   *
   * Wrapped in `runWithBranchBypass` so the branch-scoping Prisma middleware
   * does not narrow the recreate-writes to a single branch when the caller has a
   * branch selected. The wipe itself uses raw TRUNCATE (which the middleware does
   * not touch) so it always clears every branch.
   */
  async resetToBaseline(actor: { id?: string; email?: string }) {
    const actorEmail = actor?.email ?? 'unknown';
    this.logger.warn(
      `⚠️  DATABASE RESET TO BASELINE requested by ${actorEmail}`,
    );

    // Preserve current base-account passwords (read before the wipe). User is not
    // a branch-scoped model, so this returns all base users regardless of context.
    const existing = await this.prisma.user.findMany({
      where: {
        email: {
          in: SystemSettingsService.BASE_ACCOUNTS.map((a) => a.email),
        },
      },
      select: { email: true, passwordHash: true },
    });
    const hashByEmail = new Map(existing.map((u) => [u.email, u.passwordHash]));
    const accounts = await Promise.all(
      SystemSettingsService.BASE_ACCOUNTS.map(async (a) => ({
        ...a,
        passwordHash:
          hashByEmail.get(a.email) ??
          (await bcrypt.hash(a.fallbackPassword, 10)),
      })),
    );

    // Branch-config settings copied into the recreated Head Office (mirrors seed).
    const branchSettingKeys = [
      'system_timezone',
      'office_start_time',
      'office_end_time',
      'geofencing_enabled',
      'office_latitude',
      'office_longitude',
      'geofencing_radius_meters',
    ];

    const summary = await runWithBranchBypass(() =>
      this.prisma.$transaction(
        async (tx) => {
          // 1. Wipe every operational table (config tables preserved).
          const rows = await tx.$queryRaw<Array<{ tablename: string }>>`
            SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
          const targets = rows
            .map((r) => r.tablename)
            .filter((t) => !SystemSettingsService.RESET_KEEP_TABLES.has(t));
          if (targets.length > 0) {
            const list = targets.map((t) => `"${t}"`).join(', ');
            // Table names come from pg_tables (our own schema) — safe to inline.
            await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
          }

          // 2. Drop the sample-data marker (system_settings survives truncation).
          await tx.systemSetting.deleteMany({
            where: { key: 'sample_data_seeded' },
          });

          // 3. Baseline department + active Head Office branch.
          const department = await tx.department.create({
            data: {
              code: 'HRD',
              name: 'Human Resources',
              description: 'Default department for HR and Administration',
              isActive: true,
            },
          });
          const settingRows = await tx.systemSetting.findMany({
            where: { key: { in: branchSettingKeys } },
          });
          const s = Object.fromEntries(
            settingRows.map((r) => [r.key, r.value]),
          );
          const num = (v?: string) =>
            v !== undefined && v !== '' && !Number.isNaN(Number(v))
              ? Number(v)
              : null;
          const branch = await tx.branch.create({
            data: {
              code: 'HO',
              name: 'Head Office',
              description: 'Default branch',
              isActive: true,
              timezone: s['system_timezone'] ?? null,
              officeStartTime: s['office_start_time'] ?? null,
              officeEndTime: s['office_end_time'] ?? null,
              geofencingEnabled:
                s['geofencing_enabled'] !== undefined
                  ? s['geofencing_enabled'] === 'true'
                  : null,
              latitude: num(s['office_latitude']),
              longitude: num(s['office_longitude']),
              geofenceRadiusM: num(s['geofencing_radius_meters']),
            },
          });

          // 4. Recreate the three base accounts (passwords preserved from step 0).
          for (const a of accounts) {
            const employee = await tx.employee.create({
              data: {
                employeeCode: a.employeeCode,
                fullName: a.fullName,
                email: a.email,
                idCard: a.idCard,
                position: a.position,
                departmentId: department.id,
                branchId: branch.id,
                startDate: new Date(),
                baseSalary: 0,
                status: 'ACTIVE',
                dateOfBirth: new Date('1990-01-01'),
              },
            });
            const user = await tx.user.create({
              data: {
                email: a.email,
                passwordHash: a.passwordHash,
                role: a.role,
                employeeId: employee.id,
                isActive: true,
                isEmailVerified: true,
                isGlobalBranchAccess: a.isGlobalBranchAccess,
              },
            });
            if (a.role === 'ADMIN' || a.role === 'HR_MANAGER') {
              await tx.userBranchAccess.create({
                data: { userId: user.id, branchId: branch.id },
              });
            }
          }

          // 5. Audit trail (audit_logs was truncated; this row records the reset).
          await tx.auditLog.create({
            data: {
              action: 'DATABASE_RESET_TO_BASELINE',
              resourceType: 'SystemMaintenance',
              newData: { by: actorEmail, at: new Date().toISOString() },
            },
          });

          return { tablesCleared: targets.length };
        },
        { timeout: 120000, maxWait: 20000 },
      ),
    );

    this.logger.warn(
      `✅ Database reset to baseline complete by ${actorEmail} (${summary.tablesCleared} tables cleared).`,
    );
    return {
      success: true,
      message:
        'Database reset to baseline. All operational data was cleared and the base admin/HR/employee accounts, HRD department, and active Head Office branch were restored.',
      data: summary,
    };
  }

  /**
   * Get all settings as a key-value record.
   *
   * Protected (secret-bearing) keys are stripped: this is the full-table read
   * that feeds /system-settings/public, so a single careless addition to that
   * whitelist would otherwise publish a credential unauthenticated.
   */
  async getAllSettings(): Promise<Record<string, string>> {
    const settings = await this.prisma.systemSetting.findMany();
    return settings.reduce(
      (acc, curr) => {
        if (isProtectedSettingKey(curr.key)) return acc;
        acc[curr.key] = curr.value;
        return acc;
      },
      {
        allow_multiple_checkin: 'false',
        attendance_face_only: 'false',
        face_recognition_enabled: 'true',
        attendance_daily_report_enabled: 'true',
        attendance_daily_report_time: '17:30',
        attendance_day_end_time: '23:59',
        calendar_weekly_holidays: '0',
        visa_expiry_alert_days: '30',
        reminder_days_legal_document: '90,60,30,7',
        reminder_days_contract: '90,60,30,7',
        reminder_days_asset_warranty: '60,30,7',
        clearance_blocking_enabled: 'true',

        // ── Payroll extensions ────────────────────────────────────────────
        // Present here as well as in getSettingsList() because
        // getPublicSettings() reads THIS map, not the curated list. A flag
        // registered only in the list is invisible to /system-settings/public,
        // so the admin screen falls through to its hard-coded default and the
        // toggle reads OFF no matter what was saved — the same failure the
        // registry guard spec was written about, through a second door.
        payroll_item_lines_enabled: 'false',
        payroll_eosb_enabled: 'false',
        // Registered HERE as well as in the curated list, per the comment
        // above: a flag the public map does not carry is invisible to
        // /system-settings/public, so the client falls through to its own
        // default and can never see that the settlement routes are shut.
        payroll_eosb_accrual_enabled: 'false',
        payroll_eosb_settlement_enabled: 'false',
        payroll_eosb_pay_through_final_run: 'false',
        payroll_calendar_enabled: 'false',
        payroll_preflight_enabled: 'false',
        payroll_employee_recovery_enabled: 'false',
        leave_encashment_enabled: 'false',
        payroll_reports_enabled: 'false',
        // Same door as the comment above: without an entry HERE the key never
        // reaches /system-settings/public, the branding store falls through to
        // its own `false`, and the Document Templates nav entry stays hidden
        // FOREVER — including after an admin has switched the feature on and
        // watched the toggle save.
        document_engine_enabled: 'false',
        document_visual_editor_enabled: 'false',
        document_live_preview_enabled: 'false',
        document_bulk_enabled: 'false',
        employee_transfer_enabled: 'false',
        employee_grade_enabled: 'false',
        demo_autoseed_enabled: 'false',
        demo_autoseed_include_offdays: 'false',
        travel_approver_roles: 'HR_MANAGER,ADMIN',
        travel_enabled: 'true',
        training_approver_roles: 'HR_MANAGER,ADMIN',
        training_enabled: 'true',
        training_paid_by: 'COMPANY',
        reminder_days_training_certificate: '90,60,30,7',
        pdf_enabled: 'true',
        shift_reminder_prior_mins: '5',
        shift_reminder_post_mins: '5',
        office_start_time: '08:30',
        office_end_time: '17:30',
        lunch_break_start: '13:00',
        lunch_break_duration_minutes: '60',
        geofencing_enabled: 'false',
        office_latitude: '',
        office_longitude: '',
        geofencing_radius_meters: '100',
        dept_manager_min_tenure_months: '6',
        dept_manager_transition_days: '14',
        company_name_image_url: '',
        company_favicon_url: '',
        theme_preset: 'default',
        theme_font: 'montserrat',
        theme_custom_colors: '',
        theme_custom_font_family: '',
        theme_custom_font_url: '',
        overtime_enabled: 'true',
        overtime_late_threshold: '22:00',
        overtime_food_allowance_enabled: 'true',
        overtime_food_allowance_threshold: '22:00',
        overtime_food_allowance_amount: '150',
        overtime_approver_edit_enabled: 'true',
        overtime_site_allowance_enabled: 'false',
        overtime_site_allowance_max: '0',
        overtime_regular_rate: '1.5',
        overtime_late_rate: '1.5',
        overtime_double_ot_enabled: 'true',
        overtime_double_rate: '2.0',
        overtime_sunday_regular_rate: '2.0',
        overtime_sunday_late_rate: '2.0',
        overtime_sunday_late_threshold: '22:00',
        overtime_holiday_regular_rate: '2.0',
        overtime_holiday_late_rate: '2.0',
        overtime_holiday_late_threshold: '22:00',
        overtime_shift_end_time: '17:00',
        overtime_double_food_allowance_any_time: 'false',
        overtime_double_ot_allow_anytime: 'true',
        overtime_max_hours_per_day: '4',
        overtime_max_hours_per_double_day: '12',
        overtime_max_hours_per_month: '30',
        overtime_max_hours_per_year: '200',
        overtime_require_manager_approval: 'true',
        overtime_allow_employee_submit: 'true',
        overtime_require_reason: 'true',
        // Master kill-switch for the configurable Supervisor approval hierarchy.
        // When 'false' (default), leave/overtime keep their legacy single-approver
        // path regardless of any configured ApprovalWorkflow.
        supervisor_approval_enabled: 'false',
        allow_hard_delete_terminated: 'false',
        reimbursement_enabled: 'true',
        reimbursement_approver_roles: 'HR_MANAGER,ADMIN',
        reimbursement_types:
          'Travel,Per Diem,Training,Medical,Food,Office Supplies,Other',
        advance_loan_enabled: 'true',
        advance_loan_approver_roles: 'HR_MANAGER,ADMIN',
        advance_loan_max_installments: '12',
        advance_max_percent_of_salary: '100',

        // ── Loans & Advances v2 ─────────────────────────────────────────
        // Master kill-switch, mirroring supervisor_approval_enabled. OFF ships
        // the legacy installmentAmount recovery path unchanged, so an existing
        // install sees no behaviour change until it is deliberately turned on.
        loan_module_v2_enabled: 'false',
        // Recovery / affordability
        loan_min_net_pay_amount: '0',
        loan_min_net_pay_percent: '0',
        loan_max_total_deduction_percent_of_net: '50',
        loan_shortfall_policy: 'PARTIAL', // PARTIAL | DEFER | SKIP
        loan_deferral_mode: 'CARRY_FORWARD', // CARRY_FORWARD | EXTEND_TENURE
        loan_zero_salary_policy: 'DEFER', // DEFER | SKIP
        loan_min_partial_recovery_amount: '1',
        loan_unpaid_leave_policy: 'PAUSE', // CONTINUE | PAUSE | EXTEND
        loan_unpaid_leave_min_days: '1',
        loan_recovery_priority_order: 'ADVANCE,LOAN',
        loan_priority_tiebreak: 'OLDEST_FIRST', // OLDEST_FIRST | SMALLEST_BALANCE_FIRST
        loan_payment_allocation_order: 'INTEREST_FIRST',
        loan_rounding_tolerance: '1.00',
        loan_recover_on_run_types: 'REGULAR,FINAL_SETTLEMENT',
        loan_recovery_failure_policy: 'FAIL', // FAIL | WARN
        loan_final_settlement_ignores_min_net: 'true',
        loan_auto_close_on_full_recovery: 'true',
        // Interest & schedule
        loan_interest_enabled: 'false',
        loan_default_interest_method: 'NONE',
        loan_default_interest_rate: '0',
        loan_default_frequency: 'MONTHLY',
        loan_grace_period_cycles: '0',
        loan_grace_mode: 'MORATORIUM_FULL',
        loan_rounding_unit: '0.01',
        loan_min_emi_amount: '0',
        loan_max_emi_percent_of_net: '50',
        loan_flat_prepayment_interest: 'PRORATA', // FULL | PRORATA | NONE
        loan_prepayment_mode: 'REDUCE_TENURE', // REDUCE_TENURE | REDUCE_EMI
        // Eligibility
        loan_max_active_per_employee: '2',
        loan_min_service_months: '0',
        loan_max_amount_multiple_of_salary: '0', // 0 = unlimited
        loan_reference_prefix: 'LN',
        advance_loan_allow_backdated_days: '30',
        // Operations & access
        // OFF by default: this key existed with no reader at all, so no
        // deployment has ever enforced it. Turning it on is now a deliberate
        // choice that enables the two-person rule on restructures.
        loan_restructure_requires_approval: 'false',
        loan_clearance_blocking_enabled: 'true',
        loan_overdue_after_cycles: '2',
        loan_topup_enabled: 'false',
        loan_topup_mode: 'NEW_LOAN', // NEW_LOAN | IN_PLACE
        loan_security_deposit_percent: '0',
        loan_employee_self_prepay: 'false',
        advance_loan_finance_roles: 'ADMIN',
        advance_loan_auditor_roles: '',
        advance_loan_auditor_user_ids: '',
        advance_loan_writeoff_roles: 'ADMIN',

        dashboard_layout: 'v2',
      } as Record<string, string>,
    );
  }

  /**
   * Get a settings list for the UI — returns ALL configurable keys with their
   * current DB value (or env var / hardcoded default as fallback).
   */
  async getSettingsList() {
    const dbSettings = await this.prisma.systemSetting.findMany();
    const settingsMap = new Map(dbSettings.map((s) => [s.key, s.value]));
    const v = (key: string, fallback: string) =>
      settingsMap.get(key) ?? fallback;
    const mail = resolveMailConfig(settingsMap);

    return [
      // ── Company Branding ───────────────────────────────────────────────
      {
        key: 'company_name',
        value: v('company_name', 'The Company'),
        description: 'Company name shown throughout the application',
      },
      {
        key: 'company_subtitle',
        value: v('company_subtitle', 'TRS ADMIN'),
        description: 'Subtitle or designation shown in the sidebar',
      },
      {
        key: 'company_logo_url',
        value: v('company_logo_url', ''),
        description:
          'URL of the company logo image (e.g., https://example.com/logo.png)',
      },
      {
        key: 'company_logo_svg',
        value: v('company_logo_svg', ''),
        description: 'Custom SVG raw code for the logo icon (SVG format)',
      },
      {
        key: 'company_name_image_url',
        value: v('company_name_image_url', ''),
        description:
          'URL of the company name/wordmark image. When set, it replaces the company name text in the sidebar.',
      },
      {
        key: 'company_favicon_url',
        value: v('company_favicon_url', ''),
        description:
          'URL of the browser-tab favicon, auto-generated from the company logo',
      },
      {
        key: 'company_shortname',
        value: v('company_shortname', 'TRS'),
        description:
          'Company short name or abbreviation (e.g., TRS) used for generating Employee IDs',
      },
      {
        key: 'theme_preset',
        value: v('theme_preset', 'default'),
        description:
          'Selected color theme preset id (default, emerald, violet, sunset)',
      },
      {
        key: 'theme_font',
        value: v('theme_font', 'montserrat'),
        description:
          'Selected app font id (e.g. montserrat, inter, poppins, or "custom")',
      },
      {
        key: 'theme_custom_colors',
        value: v('theme_custom_colors', ''),
        description:
          'JSON of custom brand color overrides used when theme_preset = "custom"',
      },
      {
        key: 'theme_custom_font_family',
        value: v('theme_custom_font_family', ''),
        description:
          'Custom Google Font family name used when theme_font = "custom" (e.g. "Roboto Slab")',
      },
      {
        key: 'theme_custom_font_url',
        value: v('theme_custom_font_url', ''),
        description:
          'Optional full Google Fonts stylesheet URL override for the custom font',
      },
      {
        key: 'calendar_weekly_holidays',
        value: v('calendar_weekly_holidays', '0'),
        description:
          'Weekly holidays/weekend days (0 = Sunday, 6 = Saturday). Comma-separated list of day numbers.',
      },
      {
        key: 'visa_expiry_alert_days',
        value: v('visa_expiry_alert_days', '30'),
        description:
          'Days before visa expiry to start sending reminder alerts (default: 30)',
      },
      {
        key: 'reminder_days_asset_warranty',
        value: v('reminder_days_asset_warranty', '60,30,7'),
        description:
          'Comma-separated days-before-expiry tiers for asset warranty reminders (default: 60,30,7).',
      },
      {
        key: 'travel_approver_roles',
        value: v('travel_approver_roles', 'HR_MANAGER,ADMIN'),
        description:
          'Roles allowed to approve travel requests on the legacy single-approver path (used when no TRAVEL approval chain is configured).',
      },
      {
        key: 'travel_enabled',
        value: v('travel_enabled', 'true'),
        description: 'Enable the travel management module.',
      },
      {
        // Absent from this list, the WRITE path still worked — updateSettings
        // upserts arbitrary keys — but the admin toggle reads its state from
        // GET /system-settings, found nothing, and rendered OFF permanently.
        // A kill switch that lies about whether it is on is worse than no
        // toggle at all.
        key: 'employee_template_enabled',
        value: v('employee_template_enabled', 'false'),
        description:
          'Enable the configurable Employee Profile Template. Off = the shipped baseline form, identical to the pre-template behaviour.',
      },
      // ── Document / PDF engine ───────────────────────────────────────────
      {
        key: 'document_engine_enabled',
        value: v('document_engine_enabled', 'false'),
        description:
          'Enable the centralized document template engine (letters, payslips and report PDFs from admin-editable templates). Off = the previous per-module behaviour.',
      },
      {
        key: 'document_visual_editor_enabled',
        value: v('document_visual_editor_enabled', 'false'),
        description:
          'Enable the GrapesJS visual (Canva-style) template editor for new drafts. Off = the classic block builder for everything. Existing drafts keep whichever editor made them.',
      },
      {
        key: 'document_live_preview_enabled',
        value: v('document_live_preview_enabled', 'false'),
        description:
          'Allow previewing a template against a REAL employee rather than sample data. Off by default: it renders one person\u2019s actual pay to whoever is editing, so every use is audited.',
      },
      {
        key: 'document_bulk_enabled',
        value: v('document_bulk_enabled', 'false'),
        description:
          'Enable bulk document generation (for example, every payslip for a period as one PDF).',
      },
      {
        key: 'document_bulk_generate_roles',
        value: v('document_bulk_generate_roles', 'ADMIN,HR_MANAGER'),
        description:
          'Roles allowed to start a bulk document run. Narrower than the roles allowed to generate one document at a time.',
      },
      {
        key: 'document_bulk_max_items',
        value: v('document_bulk_max_items', '500'),
        description:
          'Most subjects one bulk run may cover. A run larger than this is refused with the count, rather than being silently truncated.',
      },
      {
        key: 'document_bulk_merge_max',
        value: v('document_bulk_merge_max', '200'),
        description:
          'Most documents that may be merged into a single PDF. The whole merged document lives in one renderer process, so this is a memory ceiling.',
      },
      {
        key: 'document_render_concurrency',
        value: v('document_render_concurrency', '2'),
        description:
          'How many PDFs may render at once. Chromium uses a renderer process per page; too many will exhaust container memory and take the API down with them.',
      },
      {
        key: 'document_browser_recycle_renders',
        value: v('document_browser_recycle_renders', '200'),
        description:
          'Restart the headless browser after this many renders, to bound the memory a long-lived Chromium accumulates.',
      },
      {
        key: 'document_batch_stale_minutes',
        value: v('document_batch_stale_minutes', '30'),
        description:
          'A bulk run still marked running after this long is treated as abandoned and reclaimed.',
      },
      {
        key: 'training_approver_roles',
        value: v('training_approver_roles', 'HR_MANAGER,ADMIN'),
        description:
          'Roles allowed to approve training nominations on the legacy single-approver path (used when no TRAINING approval chain is configured).',
      },
      {
        key: 'training_enabled',
        value: v('training_enabled', 'true'),
        description: 'Enable the training management module.',
      },
      {
        key: 'training_paid_by',
        value: v('training_paid_by', 'COMPANY'),
        description:
          'COMPANY = the company settles with the provider directly (cost recorded, nothing reimbursed). EMPLOYEE = the employee pays and is reimbursed through the normal expense flow.',
      },
      {
        key: 'reminder_days_training_certificate',
        value: v('reminder_days_training_certificate', '90,60,30,7'),
        description:
          'Comma-separated days-before-expiry tiers for training certificate reminders (default: 90,60,30,7).',
      },
      {
        key: 'clearance_blocking_enabled',
        value: v('clearance_blocking_enabled', 'true'),
        description:
          'Block offboarding while an employee still holds company assets. Turn off for sites that do not track assets.',
      },
      {
        key: 'pdf_enabled',
        value: v('pdf_enabled', 'true'),
        description:
          'Enable server-side PDF generation (letters, certificates). Requires Chromium in the image; turn off to degrade downloads gracefully instead of erroring.',
      },
      {
        key: 'reminder_days_legal_document',
        value: v('reminder_days_legal_document', '90,60,30,7'),
        description:
          'Comma-separated days-before-expiry tiers for visa/legal-document reminders (default: 90,60,30,7). One reminder per tier crossed.',
      },
      {
        key: 'reminder_days_contract',
        value: v('reminder_days_contract', '90,60,30,7'),
        description:
          'Comma-separated days-before-expiry tiers for employment-contract reminders (default: 90,60,30,7). One reminder per tier crossed.',
      },
      {
        key: 'shift_reminder_prior_mins',
        value: v('shift_reminder_prior_mins', '5'),
        description:
          'Minutes before shift start to send prior reminder email (default: 5)',
      },
      {
        key: 'shift_reminder_post_mins',
        value: v('shift_reminder_post_mins', '5'),
        description:
          'Minutes after shift start to send follow-up alert email (default: 5)',
      },
      {
        key: 'office_start_time',
        value: v('office_start_time', '08:30'),
        description: 'Office normal start time (HH:MM)',
      },
      {
        key: 'office_end_time',
        value: v('office_end_time', '17:30'),
        description: 'Office normal end time (HH:MM)',
      },
      {
        key: 'system_timezone',
        value: v('system_timezone', 'Asia/Kolkata'),
        description:
          'Company-wide IANA timezone (e.g. Asia/Kolkata, America/New_York). Used for office-hours business rules and payroll boundaries.',
      },

      {
        key: 'employee_start_date_max_past_days',
        value: v('employee_start_date_max_past_days', ''),
        description:
          'How many days an employment start date may be backdated. Leave blank (or 0) to allow any past date — needed to onboard late paperwork and historical records.',
      },
      {
        key: 'employee_start_date_max_future_days',
        value: v(
          'employee_start_date_max_future_days',
          String(DEFAULT_START_DATE_POLICY.maxFutureDays),
        ),
        description: `How many days ahead an employment start date may be set (default: ${DEFAULT_START_DATE_POLICY.maxFutureDays}). Future-dated employees are created ACTIVE and are included in payroll, so keep this tight.`,
      },
      {
        key: 'employee_start_date_floor',
        value: v('employee_start_date_floor', '1970-01-01'),
        description:
          'Absolute earliest employment start date accepted (YYYY-MM-DD). Guards against typos such as 0202-05-01 (default: 1970-01-01)',
      },
      {
        key: 'dept_manager_min_tenure_months',
        value: v('dept_manager_min_tenure_months', '6'),
        description:
          'Minimum tenure (in months) required for an employee to be eligible as a department manager (default: 6)',
      },
      {
        key: 'dept_manager_transition_days',
        value: v('dept_manager_transition_days', '14'),
        description:
          'Standard transition period (in days) for a department manager handover (default: 14)',
      },
      // ── Attendance ──────────────────────────────────────────────────────
      {
        key: 'allow_multiple_checkin',
        value: v('allow_multiple_checkin', 'false'),
        description:
          'Allow employees to check in and out multiple times in the same day',
      },
      {
        key: 'attendance_face_only',
        value: v('attendance_face_only', 'false'),
        description:
          'Require employees to check in and check out only via face recognition',
      },
      {
        key: 'face_recognition_enabled',
        value: v('face_recognition_enabled', 'true'),
        description:
          'When enabled, face-recognition AI model is loaded and used to verify identity. When disabled, only the face image is captured and stored in S3 (no AI matching).',
      },
      {
        key: 'attendance_daily_report_enabled',
        value: v('attendance_daily_report_enabled', 'true'),
        description:
          'Enable daily attendance summary email sent to administrator (self-mail) at the configured report time',
      },
      {
        key: 'attendance_daily_report_time',
        value: v('attendance_daily_report_time', v('office_end_time', '17:30')),
        description:
          'Time (HH:MM) the daily attendance report email is sent. Absentees are computed at send time without modifying records; official ABSENT marking happens at the day-end boundary.',
      },
      {
        key: 'strict_attendance_mode',
        value: v('strict_attendance_mode', 'false'),
        description:
          'When enabled, employees who forget to check out are marked MISSED_CHECKOUT (0 work hours) instead of being auto-checked out at the attendance day-end boundary',
      },
      {
        key: 'attendance_day_end_time',
        value: v('attendance_day_end_time', '23:59'),
        description:
          'Attendance day-end boundary (HH:MM). Times 12:00-23:59 close the day the same evening; times 00:00-11:59 close it early the NEXT morning, so overnight work counts toward the previous day. At this time no-shows are marked ABSENT and open sessions are auto-closed (MISSED_CHECKOUT in strict mode).',
      },
      {
        key: 'monthly_attendance_request_limit',
        value: v('monthly_attendance_request_limit', '3'),
        description:
          'Max attendance-correction requests an employee may submit per calendar month via self-service (0 = unlimited). HR-created corrections are exempt.',
      },
      {
        key: 'lunch_break_start',
        value: v('lunch_break_start', '13:00'),
        description:
          'Company-wide lunch break start time (HH:MM, company timezone). Employees whose first check-in of the day is at or after this time (e.g. afternoon/evening shifts) get no automatic lunch deduction.',
      },
      {
        key: 'lunch_break_duration_minutes',
        value: v('lunch_break_duration_minutes', '60'),
        description:
          'Lunch break length in minutes, deducted automatically from daily work hours on fixed shifts working more than 4h (0 = never deduct). Not applied to flexible shifts, to employees who check in at/after the lunch start time, or to days with an explicitly tracked lunch session. Also used as the lunch-overrun reminder threshold.',
      },
      // ── Geofencing ───────────────────────────────────────────────────────
      {
        key: 'geofencing_enabled',
        value: v('geofencing_enabled', 'false'),
        description:
          'When enabled, employee self check-in (button and face recognition) requires GPS coordinates within the configured radius of the office location. HR-triggered manual check-ins are exempt.',
      },
      {
        key: 'office_latitude',
        value: v('office_latitude', ''),
        description:
          'Office latitude (decimal degrees, -90 to 90). Required before geofencing can be enabled.',
      },
      {
        key: 'office_longitude',
        value: v('office_longitude', ''),
        description:
          'Office longitude (decimal degrees, -180 to 180). Required before geofencing can be enabled.',
      },
      {
        key: 'geofencing_radius_meters',
        value: v('geofencing_radius_meters', '100'),
        description:
          'Allowed distance in meters from the office location within which check-in is permitted.',
      },
      // ── Employee Management ─────────────────────────────────────────────
      {
        key: 'allow_hard_delete_terminated',
        value: v('allow_hard_delete_terminated', 'false'),
        description:
          'When enabled, ADMIN and HR_MANAGER can permanently delete terminated employees and all their data from the database. This action is irreversible.',
      },
      // ── Email / SMTP ────────────────────────────────────────────────────
      // Resolved through `resolveMailConfig`, NOT through `v()`: an empty
      // `mail_*` row means "not configured" and must fall through to the
      // environment, which is what the transporter does. `v()` falls through
      // only when the row is absent, so a blanked row showed an empty SMTP form
      // over a live env-configured server.
      {
        key: 'mail_enabled',
        value: mail.mail_enabled,
        description: 'Enable email notifications',
      },
      {
        key: 'mail_host',
        value: mail.mail_host,
        description: 'SMTP Server Host',
      },
      {
        key: 'mail_port',
        value: mail.mail_port,
        description: 'SMTP Server Port',
      },
      {
        key: 'mail_user',
        value: mail.mail_user,
        description: 'SMTP Username/Email',
      },
      {
        key: 'mail_password',
        value: mail.mail_password,
        description: 'SMTP Password/App Password',
      },
      {
        key: 'mail_from',
        value: mail.mail_from,
        description: 'Sender Email Address',
      },
      {
        key: 'mail_from_name',
        value: mail.mail_from_name,
        description: 'Sender Name',
      },
      {
        key: 'mail_bcc',
        value: mail.mail_bcc,
        description: 'BCC Email Address(es) (comma-separated)',
      },

      // ── Payroll — General ───────────────────────────────────────────────
      {
        key: 'payroll_country',
        value: v('payroll_country', 'IN'),
        description:
          'Country code that drives payroll rules (IN=India, VN=Vietnam, CUSTOM)',
      },
      {
        key: 'payroll_currency',
        value: v('payroll_currency', 'INR'),
        description: 'ISO currency code used in payroll',
      },
      {
        key: 'payroll_currency_symbol',
        value: v('payroll_currency_symbol', '₹'),
        description: 'Currency display symbol shown on payslips',
      },
      {
        key: 'payroll_currency_display',
        value: v('payroll_currency_display', 'symbol'),
        description:
          "How amounts render site-wide: 'symbol' (e.g. ₹1,234) or 'code' (e.g. INR 1,234)",
      },
      {
        key: 'payroll_work_hours_per_day',
        value: v('payroll_work_hours_per_day', '8'),
        description: 'Standard working hours per day',
      },
      {
        key: 'payroll_work_days_per_week',
        value: v('payroll_work_days_per_week', '5'),
        description: 'Working days per week (5 = Mon–Fri, 6 = Mon–Sat)',
      },
      {
        key: 'payroll_overtime_rate',
        value: v('payroll_overtime_rate', '1.5'),
        description: 'Overtime multiplier (1.5 = 150 % of regular hourly rate)',
      },

      // ── Provident Fund / PF ─────────────────────────────────────────────
      {
        key: 'payroll_pf_enabled',
        value: v('payroll_pf_enabled', 'true'),
        description: 'Enable Provident Fund (PF) / Social Insurance deduction',
      },
      {
        key: 'payroll_pf_employee_rate',
        value: v('payroll_pf_employee_rate', '0.12'),
        description:
          'Employee PF contribution rate (India: 12 %, Vietnam: 10.5 %)',
      },
      {
        key: 'payroll_pf_employer_rate',
        value: v('payroll_pf_employer_rate', '0.12'),
        description: 'Employer PF contribution rate (India: 12 %)',
      },
      {
        key: 'payroll_pf_salary_cap',
        value: v('payroll_pf_salary_cap', '15000'),
        description:
          'Maximum monthly salary subject to PF (India: ₹15,000). Set 0 for no cap.',
      },
      {
        key: 'payroll_pf_on_full_salary',
        value: v('payroll_pf_on_full_salary', 'false'),
        description:
          'Calculate PF on full basic salary ignoring the salary cap (voluntary higher PF)',
      },

      // ── Professional Tax ────────────────────────────────────────────────
      {
        key: 'payroll_professional_tax_enabled',
        value: v('payroll_professional_tax_enabled', 'true'),
        description: 'Enable Professional Tax deduction (India state levy)',
      },
      {
        key: 'payroll_professional_tax_slabs',
        value: v(
          'payroll_professional_tax_slabs',
          JSON.stringify([
            { upTo: 10000, tax: 0 },
            { upTo: 15000, tax: 110 },
            { upTo: 20000, tax: 130 },
            { upTo: 25000, tax: 150 },
            { upTo: 999999999, tax: 200 },
          ]),
        ),
        description:
          'Monthly professional tax slabs as JSON [{upTo, tax}]. Defaults: Karnataka slabs.',
      },

      // ── Income Tax / TDS ────────────────────────────────────────────────
      {
        key: 'payroll_tax_regime',
        value: v('payroll_tax_regime', 'new'),
        description:
          'Tax regime: "new" (India New Regime FY25), "old" (India Old Regime), or "progressive" (Vietnam monthly)',
      },
      {
        key: 'payroll_standard_deduction',
        value: v('payroll_standard_deduction', '75000'),
        description:
          'Annual standard deduction before income tax (India New Regime FY25: ₹75,000)',
      },
      {
        key: 'payroll_personal_deduction_monthly',
        value: v('payroll_personal_deduction_monthly', '6250'),
        description:
          'Monthly personal deduction used in tax calculation (standard_deduction ÷ 12)',
      },
      {
        key: 'payroll_tax_brackets',
        value: v(
          'payroll_tax_brackets',
          JSON.stringify([
            { limit: 300000, rate: 0.0 },
            { limit: 700000, rate: 0.05 },
            { limit: 1000000, rate: 0.1 },
            { limit: 1200000, rate: 0.15 },
            { limit: 1500000, rate: 0.2 },
            { limit: 999999999, rate: 0.3 },
          ]),
        ),
        description:
          'Annual income tax slabs as JSON [{limit, rate}]. India New Regime FY 2025-26 annual limits.',
      },
      {
        key: 'payroll_tax_calculation_period',
        value: v('payroll_tax_calculation_period', 'annual'),
        description:
          '"annual" = project monthly income × 12, apply slabs, divide tax by 12 (India). "monthly" = apply slabs directly to monthly income (Vietnam).',
      },
      {
        key: 'payroll_basic_salary_percentage',
        value: v('payroll_basic_salary_percentage', '40'),
        description:
          'Percentage of CTC treated as Basic Salary for PF base (India: typically 40–50 %)',
      },

      // ── ESI ─────────────────────────────────────────────────────────────
      {
        key: 'payroll_esi_enabled',
        value: v('payroll_esi_enabled', 'true'),
        description: 'Enable Employee State Insurance (ESI) — India only',
      },
      {
        key: 'payroll_esi_employee_rate',
        value: v('payroll_esi_employee_rate', '0.0075'),
        description: 'Employee ESI rate (India: 0.75 %)',
      },
      {
        key: 'payroll_esi_employer_rate',
        value: v('payroll_esi_employer_rate', '0.0325'),
        description: 'Employer ESI rate (India: 3.25 %)',
      },
      {
        key: 'payroll_esi_salary_cap',
        value: v('payroll_esi_salary_cap', '21000'),
        description:
          'Maximum gross monthly salary eligible for ESI (India: ₹21,000). Above this limit, ESI is not applicable.',
      },

      // ── Gratuity ────────────────────────────────────────────────────────
      {
        key: 'payroll_gratuity_enabled',
        value: v('payroll_gratuity_enabled', 'false'),
        description: 'Show gratuity provision on payslip (informational)',
      },
      {
        key: 'payroll_gratuity_rate',
        value: v('payroll_gratuity_rate', '0.0481'),
        description:
          'Monthly gratuity provision rate (India: 4.81 % of basic = 15/26 ÷ 12)',
      },

      // ── Daily Wage ──────────────────────────────────────────────────────
      // These affect ONLY employees whose pay basis is DAILY (baseSalary is a
      // per-day rate). Monthly staff are never touched by any of them.
      {
        key: 'payroll_daily_wage_statutory_deductions',
        value: v('payroll_daily_wage_statutory_deductions', 'true'),
        description:
          'Put daily-wage staff through the same PF / ESI / professional-tax / income-tax pipeline as monthly staff. Off → their gross is paid with only discipline deductions and advance/loan recovery applied.',
      },
      {
        key: 'payroll_daily_wage_pay_leave',
        value: v('payroll_daily_wage_pay_leave', 'false'),
        description:
          'Pay daily-wage staff their day rate for approved PAID leave days. Off (default) → only days actually worked are paid.',
      },
      {
        key: 'payroll_daily_wage_pay_holidays',
        value: v('payroll_daily_wage_pay_holidays', 'false'),
        description:
          'Pay daily-wage staff their day rate for public holidays in the period — excluding holidays falling on a weekly-off day, and days they actually worked (already paid). Off (default) → holidays are unpaid.',
      },

      // ── Section 87A Rebate ──────────────────────────────────────────────
      {
        key: 'payroll_tax_rebate_enabled',
        value: v('payroll_tax_rebate_enabled', 'true'),
        description:
          'Enable Section 87A rebate: if annual taxable income ≤ threshold, income tax is nil (India: ₹7,00,000)',
      },
      {
        key: 'payroll_tax_rebate_limit',
        value: v('payroll_tax_rebate_limit', '700000'),
        description:
          'Annual taxable income threshold below which Section 87A rebate applies (India: ₹7,00,000)',
      },

      // ── Health & Education Cess ──────────────────────────────────────────
      {
        key: 'payroll_cess_enabled',
        value: v('payroll_cess_enabled', 'true'),
        description: 'Enable Health & Education Cess on income tax (India: 4%)',
      },
      {
        key: 'payroll_cess_rate',
        value: v('payroll_cess_rate', '0.04'),
        description:
          'Cess rate applied on top of income tax (India: 0.04 = 4%)',
      },

      // ── Payroll extensions — feature switches ────────────────────────────
      //
      // Every key here defaults OFF, and every description says what OFF means,
      // because that sentence is the whole safety argument: a live client runs
      // the base payroll and must keep running it byte-for-byte until someone
      // deliberately turns a feature on.
      //
      // NOTE on `payroll_eosb_enabled`: it deliberately does NOT reuse
      // `payroll_gratuity_enabled`, which `applyCountryPreset` already sets to
      // 'true' for AE and OM. Any instance that ever applied the Oman preset has
      // that key set, so gating end-of-service on it would switch the feature on
      // at deploy time for exactly the customers who must not be surprised by it.
      {
        key: 'payroll_item_lines_enabled',
        value: v('payroll_item_lines_enabled', 'false'),
        description:
          'Write an itemised earning/deduction breakdown alongside each payslip total. ' +
          'Off (default) → no line rows are written and payslips render exactly as today.',
      },
      {
        key: 'payroll_item_lines_strict_reconciliation',
        value: v('payroll_item_lines_strict_reconciliation', 'true'),
        description:
          'Refuse to produce a payroll whose itemised lines do not sum to its stored totals. ' +
          'Off → the mismatch is logged and audited and the run proceeds.',
      },
      {
        key: 'payroll_eosb_enabled',
        value: v('payroll_eosb_enabled', 'false'),
        description:
          'Master switch for end-of-service benefits. Off (default) → no gratuity is accrued, ' +
          'no settlement can be prepared, and payroll behaves exactly as before. Deliberately ' +
          'separate from payroll_gratuity_enabled, which the AE and OM presets already set true.',
      },
      {
        key: 'payroll_eosb_accrual_enabled',
        value: v('payroll_eosb_accrual_enabled', 'false'),
        description:
          'Write a monthly gratuity accrual when a payroll locks. ' +
          'Off (default) → no liability ledger is built.',
      },
      {
        key: 'payroll_eosb_settlement_enabled',
        value: v('payroll_eosb_settlement_enabled', 'false'),
        description:
          'Allow final-settlement documents to be prepared on exit. ' +
          'Off (default) → the settlement routes answer 404 and an exit is unchanged.',
      },
      {
        key: 'payroll_eosb_unknown_nationality_policy',
        value: v('payroll_eosb_unknown_nationality_policy', 'BLOCK'),
        description:
          "What to do when an employee's nationality class is unrecorded: BLOCK (default — " +
          'refuse to accrue and report it) or SKIP (accrue nothing, warn). Never a silent default class.',
      },
      {
        key: 'payroll_eosb_service_year_days',
        value: v('payroll_eosb_service_year_days', '365'),
        description:
          'Days in a service year for the fractional years-of-service calculation.',
      },
      {
        key: 'payroll_eosb_pay_through_final_run',
        value: v('payroll_eosb_pay_through_final_run', 'false'),
        description:
          'Pay the end-of-service benefit through the FINAL_SETTLEMENT payroll run, ' +
          'so it reaches the payslip and the wage file the bank receives. ' +
          'Off (default) → gratuity stays a provision settled outside payroll and ' +
          'the run carries pending salary only. Which is correct is a local legal ' +
          'question and differs by client.',
      },
      {
        key: 'leave_encashment_enabled',
        value: v('leave_encashment_enabled', 'false'),
        description:
          'Allow in-service leave encashment requests and pay them through payroll. ' +
          'Off (default) → the routes answer 404 and payroll pays no encashment.',
      },
      {
        key: 'leave_encashment_taxable',
        value: v('leave_encashment_taxable', 'true'),
        description:
          'Include leave encashment in the taxable and statutory base. ' +
          'Off → it is paid post-tax, like a reimbursement.',
      },
      {
        key: 'leave_carry_forward_enabled',
        value: v('leave_carry_forward_enabled', 'false'),
        description:
          'Allow the year-end carry-forward operation to write carriedOver balances. ' +
          'Off (default) → no leave balance is ever moved automatically.',
      },
      {
        key: 'payroll_calendar_enabled',
        value: v('payroll_calendar_enabled', 'false'),
        description:
          'Record per-branch payroll periods with cut-off and payment dates. ' +
          'Off (default) → a period stays the calendar month and no cut-off is checked.',
      },
      {
        key: 'payroll_cutoff_enforcement',
        value: v('payroll_cutoff_enforcement', 'WARN'),
        description:
          'What a post-cut-off input does: WARN (default — the pre-run check reports it) ' +
          'or BLOCK (generation is refused).',
      },
      {
        key: 'payroll_preflight_enabled',
        value: v('payroll_preflight_enabled', 'false'),
        description:
          'Enable the pre-run validation checklist. ' +
          "Off (default) → the route answers 404 and the run's own guards are the only checks.",
      },
      {
        key: 'payroll_employee_recovery_enabled',
        value: v('payroll_employee_recovery_enabled', 'false'),
        description:
          'Recover asset damage, training bonds and notice shortfalls through payroll. ' +
          'Off (default) → no recovery is taken and no recovery ledger is read.',
      },
      {
        key: 'payroll_recovery_ladder_position',
        value: v('payroll_recovery_ladder_position', 'AFTER_LOAN'),
        description:
          'Where an employee recovery sits in the recovery ladder: AFTER_LOAN (default) or ' +
          'BEFORE_LOAN. A recovery never ignores the minimum-take-home floor either way.',
      },
      {
        key: 'payroll_recovery_respects_min_net',
        value: v('payroll_recovery_respects_min_net', 'true'),
        description:
          'Bound an employee recovery by the same minimum-take-home floor loan instalments ' +
          'respect. Off → it is bounded only by the pay available.',
      },
      {
        key: 'employee_transfer_enabled',
        value: v('employee_transfer_enabled', 'false'),
        description:
          'Enable the reviewed branch-transfer flow. Off (default) → PATCH /employees/:id ' +
          '{ branchId } stays refused and no transfer route accepts a request.',
      },
      {
        key: 'payroll_transfer_pay_basis',
        value: v('payroll_transfer_pay_basis', 'PERIOD_END'),
        description:
          'Which date decides the paying branch: PERIOD_END (default — current behaviour) or ' +
          'CUT_OFF (requires the payroll calendar).',
      },
      {
        key: 'employee_grade_enabled',
        value: v('employee_grade_enabled', 'false'),
        description:
          'Enable employee grades and grade-based salary structures. ' +
          'Off (default) → no grade is assigned and no eligibility check runs.',
      },
      {
        key: 'payroll_reports_enabled',
        value: v('payroll_reports_enabled', 'false'),
        description:
          'Enable the payroll reporting suite. ' +
          'Off (default) → the XLSX export is the only payroll reporting.',
      },
      {
        key: 'demo_autoseed_enabled',
        value: v('demo_autoseed_enabled', 'false'),
        description:
          'DEMO SERVERS ONLY. Nightly job (00:30 company-local) that opens today’s ' +
          'attendance for every active employee and closes yesterday’s open rows, so the ' +
          'demo never shows an empty day. Off (default) — it writes attendance, so it must ' +
          'stay off on a real tenant.',
      },
      {
        key: 'demo_autoseed_include_offdays',
        value: v('demo_autoseed_include_offdays', 'false'),
        description:
          'DEMO SERVERS ONLY. Let the autoseed fill weekly off days too, so a branch ' +
          'whose weekend is Fri/Sat does not leave every screen empty for two days. ' +
          'Off (default) → weekly offs stay empty, as on a real tenant. Has no effect ' +
          'unless demo_autoseed_enabled is on, and never rewrites the branch working week.',
      },

      // ── Custom Component Labels ──────────────────────────────────────────
      // Empty string = use country-meta default. Set to override display names.
      {
        key: 'payroll_label_general',
        value: v('payroll_label_general', ''),
        description: 'Custom display name for the General Payroll section',
      },
      {
        key: 'payroll_label_pf',
        value: v('payroll_label_pf', ''),
        description:
          'Custom display name for the PF / Social Insurance section',
      },
      {
        key: 'payroll_label_pf_employee_rate',
        value: v('payroll_label_pf_employee_rate', ''),
        description: 'Custom label for the PF employee contribution rate field',
      },
      {
        key: 'payroll_label_pf_employer_rate',
        value: v('payroll_label_pf_employer_rate', ''),
        description: 'Custom label for the PF employer contribution rate field',
      },
      {
        key: 'payroll_label_pf_cap',
        value: v('payroll_label_pf_cap', ''),
        description: 'Custom label for the PF salary cap field',
      },
      {
        key: 'payroll_label_esi',
        value: v('payroll_label_esi', ''),
        description:
          'Custom display name for the ESI / Health Insurance section',
      },
      {
        key: 'payroll_label_esi_employee_rate',
        value: v('payroll_label_esi_employee_rate', ''),
        description:
          'Custom label for the ESI employee contribution rate field',
      },
      {
        key: 'payroll_label_esi_employer_rate',
        value: v('payroll_label_esi_employer_rate', ''),
        description:
          'Custom label for the ESI employer contribution rate field',
      },
      {
        key: 'payroll_label_esi_cap',
        value: v('payroll_label_esi_cap', ''),
        description: 'Custom label for the ESI salary cap / threshold field',
      },
      {
        key: 'payroll_label_pt',
        value: v('payroll_label_pt', ''),
        description:
          'Custom display name for the Professional Tax / Regional Tax section',
      },
      {
        key: 'payroll_label_cess',
        value: v('payroll_label_cess', ''),
        description: 'Custom display name for the Cess / Surcharge field',
      },
      {
        key: 'payroll_label_rebate',
        value: v('payroll_label_rebate', ''),
        description: 'Custom display name for the Tax Rebate / Credit field',
      },
      {
        key: 'payroll_label_gratuity',
        value: v('payroll_label_gratuity', ''),
        description:
          'Custom display name for the Gratuity / End-of-Service section',
      },
      {
        key: 'payroll_label_income_tax',
        value: v('payroll_label_income_tax', ''),
        description: 'Custom display name for the Income Tax / TDS section',
      },
      // ── Overtime Settings ──────────────────────────────────────────────
      {
        key: 'overtime_enabled',
        value: v('overtime_enabled', 'true'),
        description:
          'Enable or disable the Overtime request/tracking system globally',
      },
      {
        key: 'overtime_late_threshold',
        value: v('overtime_late_threshold', '22:00'),
        description:
          'Time threshold after which overtime is considered LATE and eligible for food allowance (format HH:MM)',
      },
      {
        key: 'overtime_food_allowance_enabled',
        value: v('overtime_food_allowance_enabled', 'true'),
        description: 'Enable food allowance payout for late overtime shifts',
      },
      {
        key: 'overtime_food_allowance_threshold',
        value: v('overtime_food_allowance_threshold', '22:00'),
        description:
          'Time threshold after which an overtime request qualifies for the food allowance (format HH:MM). Independent of the late OT pay-rate threshold.',
      },
      {
        key: 'overtime_food_allowance_amount',
        value: v('overtime_food_allowance_amount', '150'),
        description:
          'Flat food allowance amount paid per late overtime session',
      },
      {
        key: 'overtime_approver_edit_enabled',
        value: v('overtime_approver_edit_enabled', 'true'),
        description:
          'Allow an approver to correct the worked window and the allowances of an overtime request while approving it. Off => approve/reject only, exactly as filed.',
      },
      {
        key: 'overtime_site_allowance_enabled',
        value: v('overtime_site_allowance_enabled', 'false'),
        description:
          'Allow an approver to grant a per-request site allowance on overtime. Requires overtime_approver_edit_enabled.',
      },
      {
        key: 'overtime_site_allowance_max',
        value: v('overtime_site_allowance_max', '0'),
        description:
          'Ceiling for a single site allowance an approver may grant. 0 = no ceiling.',
      },
      {
        key: 'overtime_regular_rate',
        value: v('overtime_regular_rate', '1.5'),
        description:
          'Overtime pay rate multiplier for hours worked before the late threshold (e.g. 1.5 for 1.5x basic pay rate)',
      },
      {
        key: 'overtime_late_rate',
        value: v('overtime_late_rate', '1.5'),
        description:
          'Overtime pay rate multiplier for hours worked after the late threshold (e.g. 1.5 for 1.5x basic pay rate)',
      },
      {
        key: 'overtime_double_ot_enabled',
        value: v('overtime_double_ot_enabled', 'true'),
        description:
          'Enable double OT multiplier for Sundays and Public Holidays',
      },
      {
        key: 'overtime_double_rate',
        value: v('overtime_double_rate', '2.0'),
        description:
          'Legacy flat double-OT multiplier. Fallback for rows with no day-type; superseded by the per-day-type Sunday/Holiday rates below.',
      },
      {
        key: 'overtime_sunday_regular_rate',
        value: v(
          'overtime_sunday_regular_rate',
          v('overtime_double_rate', '2.0'),
        ),
        description:
          'Sunday overtime multiplier for hours worked before the Sunday late threshold',
      },
      {
        key: 'overtime_sunday_late_rate',
        value: v('overtime_sunday_late_rate', v('overtime_double_rate', '2.0')),
        description:
          'Sunday overtime multiplier for hours worked after the Sunday late threshold',
      },
      {
        key: 'overtime_sunday_late_threshold',
        value: v(
          'overtime_sunday_late_threshold',
          v('overtime_late_threshold', '22:00'),
        ),
        description:
          'Time after which Sunday overtime is paid at the Sunday late rate (format HH:MM)',
      },
      {
        key: 'overtime_holiday_regular_rate',
        value: v(
          'overtime_holiday_regular_rate',
          v('overtime_double_rate', '2.0'),
        ),
        description:
          'Public holiday overtime multiplier for hours worked before the holiday late threshold',
      },
      {
        key: 'overtime_holiday_late_rate',
        value: v(
          'overtime_holiday_late_rate',
          v('overtime_double_rate', '2.0'),
        ),
        description:
          'Public holiday overtime multiplier for hours worked after the holiday late threshold',
      },
      {
        key: 'overtime_holiday_late_threshold',
        value: v(
          'overtime_holiday_late_threshold',
          v('overtime_late_threshold', '22:00'),
        ),
        description:
          'Time after which public holiday overtime is paid at the holiday late rate (format HH:MM)',
      },
      {
        key: 'overtime_shift_end_time',
        value: v('overtime_shift_end_time', '17:00'),
        description:
          'Time from which weekday overtime shifts can start being requested (format HH:MM)',
      },
      {
        key: 'overtime_double_food_allowance_any_time',
        value: v('overtime_double_food_allowance_any_time', 'false'),
        description:
          'Whether food allowance is paid for Sunday/Holiday overtime even before the late threshold is reached',
      },
      {
        key: 'overtime_double_ot_allow_anytime',
        value: v('overtime_double_ot_allow_anytime', 'true'),
        description:
          'Whether overtime on Sundays and Public Holidays can be requested at any time of day (skipping shift hours guard)',
      },
      {
        key: 'overtime_max_hours_per_day',
        value: v('overtime_max_hours_per_day', '4'),
        description:
          'Maximum overtime hours allowed to be submitted per employee per day',
      },
      {
        key: 'overtime_max_hours_per_double_day',
        value: v('overtime_max_hours_per_double_day', '12'),
        description:
          'Maximum overtime hours allowed per employee on a double-OT day (Sunday / Public Holiday full-shift rest day)',
      },
      {
        key: 'overtime_max_hours_per_month',
        value: v('overtime_max_hours_per_month', '30'),
        description:
          'Maximum overtime hours allowed to be approved per employee per month',
      },
      {
        key: 'overtime_max_hours_per_year',
        value: v('overtime_max_hours_per_year', '200'),
        description:
          'Maximum overtime hours allowed to be approved per employee per year',
      },
      {
        key: 'overtime_require_manager_approval',
        value: v('overtime_require_manager_approval', 'true'),
        description:
          'Require manager/approver approval before overtime hours/allowances are included in payroll',
      },
      {
        key: 'overtime_allow_employee_submit',
        value: v('overtime_allow_employee_submit', 'true'),
        description:
          'Allow standard employees to submit their own overtime requests',
      },
      {
        key: 'overtime_require_reason',
        value: v('overtime_require_reason', 'true'),
        description:
          'Require a written reason when submitting an overtime request. When off, the reason field is optional and may be left blank.',
      },

      // ── Approval Hierarchy ─────────────────────────────────────────────
      {
        key: 'supervisor_approval_enabled',
        value: v('supervisor_approval_enabled', 'false'),
        description:
          'Master switch for the configurable Supervisor approval hierarchy. When off, leave/overtime use the legacy single-approver flow regardless of configured workflows.',
      },

      // ── Reimbursement ──────────────────────────────────────────────────
      {
        key: 'reimbursement_enabled',
        value: v('reimbursement_enabled', 'true'),
        description:
          'Enable the reimbursement module (employee expense claims)',
      },
      {
        key: 'reimbursement_approver_roles',
        value: v('reimbursement_approver_roles', 'HR_MANAGER,ADMIN'),
        description:
          'Comma-separated roles allowed to approve reimbursement requests (MANAGER, HR_MANAGER, ADMIN). Any one enabled approver can approve.',
      },
      {
        key: 'reimbursement_types',
        value: v(
          'reimbursement_types',
          'Travel,Per Diem,Training,Medical,Food,Office Supplies,Other',
        ),
        description:
          'Comma-separated list of reimbursement types employees can choose from',
      },

      // ── Salary Advance & Loan ──────────────────────────────────────────
      {
        key: 'advance_loan_enabled',
        value: v('advance_loan_enabled', 'true'),
        description:
          'Enable the salary advance & loan module (employee advances and loans repaid via payroll)',
      },
      {
        key: 'advance_loan_approver_roles',
        value: v('advance_loan_approver_roles', 'HR_MANAGER,ADMIN'),
        description:
          'Comma-separated roles allowed to approve advance/loan requests (MANAGER, HR_MANAGER, ADMIN). Any one enabled approver can approve.',
      },
      {
        key: 'advance_loan_max_installments',
        value: v('advance_loan_max_installments', '12'),
        description:
          'Maximum number of repayment installments an approver may set for a loan',
      },
      {
        key: 'advance_max_percent_of_salary',
        value: v('advance_max_percent_of_salary', '100'),
        description:
          "Maximum salary advance as a percentage of the employee's monthly pay; larger requests are blocked at approval and must use a loan",
      },

      // ── Loans & Advances v2 ────────────────────────────────────────────
      {
        key: 'loan_module_v2_enabled',
        value: v('loan_module_v2_enabled', 'false'),
        description:
          'MASTER SWITCH. Off = the legacy behaviour exactly: the full instalment is recovered with no affordability cap, no minimum take-home floor and no leave pause. Turn on to enable schedule-driven recovery.',
      },
      {
        key: 'loan_interest_enabled',
        value: v('loan_interest_enabled', 'false'),
        description:
          'Allow interest-bearing loans. Off forces every schedule to zero interest regardless of the rate on the request.',
      },
      {
        key: 'loan_default_interest_method',
        value: v('loan_default_interest_method', 'NONE'),
        description:
          'Default interest method for new loans: NONE, FLAT or REDUCING_BALANCE',
      },
      {
        key: 'loan_default_interest_rate',
        value: v('loan_default_interest_rate', '0'),
        description: 'Default annual interest rate (percent) for new loans',
      },
      {
        key: 'loan_min_net_pay_amount',
        value: v('loan_min_net_pay_amount', '0'),
        description:
          'Protected minimum take-home. Loan recovery never drives net pay below this figure.',
      },
      {
        key: 'loan_min_net_pay_percent',
        value: v('loan_min_net_pay_percent', '0'),
        description:
          'Protected minimum take-home as a percentage of net pay; the higher of this and the absolute amount applies.',
      },
      {
        key: 'loan_max_total_deduction_percent_of_net',
        value: v('loan_max_total_deduction_percent_of_net', '50'),
        description:
          'Ceiling on total loan recovery in one cycle, as a percentage of net pay',
      },
      {
        key: 'loan_shortfall_policy',
        value: v('loan_shortfall_policy', 'PARTIAL'),
        description:
          'When net pay cannot cover the instalment: PARTIAL (take what is available), DEFER (take nothing, carry forward) or SKIP',
      },
      // The nine entries marked below were WRITABLE and UNREADABLE: the engine
      // reads them, `updateSettings()` upserts them, and this list — the only
      // thing GET /system-settings returns — did not name them. An admin could
      // not see what they had set, and nothing (not the UI, not a test harness)
      // could restore a previous value, because there was no previous value to
      // read. Every default here is the one the engine falls back to, taken from
      // DEFAULT_LOAN_POLICY / the getSetting() call site, not invented.
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_min_partial_recovery_amount',
        value: v('loan_min_partial_recovery_amount', '1'),
        description:
          'Smallest instalment worth collecting under PARTIAL recovery. A shortfall below this is deferred instead, so payroll never raises a token deduction line.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_deferral_mode',
        value: v('loan_deferral_mode', 'CARRY_FORWARD'),
        description:
          'What a deferred instalment does to the schedule: CARRY_FORWARD adds it to the next cycle and keeps the end date; EXTEND_TENURE pushes the remaining instalments out by one cycle each.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_priority_tiebreak',
        value: v('loan_priority_tiebreak', 'OLDEST_FIRST'),
        description:
          'Which debt is recovered first when two share a priority: OLDEST_FIRST or SMALLEST_BALANCE_FIRST.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_payment_allocation_order',
        value: v('loan_payment_allocation_order', 'INTEREST_FIRST'),
        description:
          'How one payment is split on an interest-bearing loan: INTEREST_FIRST (interest, then principal) or PRINCIPAL_FIRST.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_final_settlement_ignores_min_net',
        value: v('loan_final_settlement_ignores_min_net', 'true'),
        description:
          'On a FINAL_SETTLEMENT run, recover the whole outstanding balance even where that breaks the minimum take-home floor — there is no later cycle to recover it in.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_auto_close_on_full_recovery',
        value: v('loan_auto_close_on_full_recovery', 'true'),
        description:
          'Close a loan automatically the moment its balance reaches zero. Off leaves it ACTIVE for a human to close.',
      },
      {
        // Unreadable until now. Fallback: LoanPolicyService.resolve().
        key: 'loan_grace_period_cycles',
        value: v('loan_grace_period_cycles', '0'),
        description:
          'Payroll cycles after disbursement before the first instalment is recovered (0 = recover from the next cycle).',
      },
      {
        // Unreadable until now. Fallback: LoanScheduleService.roundingUnit().
        key: 'loan_rounding_unit',
        value: v('loan_rounding_unit', '0.01'),
        description:
          'Unit each scheduled instalment is rounded to when a schedule is built (0.01 = to the minor unit, 1 = to whole currency). The residual is reconciled into the final instalment.',
      },
      // The ten below were the SECOND generation of the same defect. Each was
      // seeded, documented and read by nothing; the gap-closure work gave every
      // one of them a reader, which is exactly what turns an inert key into an
      // unreadable one. A key the engine obeys and this list does not name
      // cannot be seen, cannot be restored, and cannot be flipped by a test
      // harness that has to put it back. Defaults are the reader's own
      // fallback, quoted from the call site.
      {
        // Reader: AdvanceLoansService.resolveTerms().
        key: 'loan_default_frequency',
        value: v('loan_default_frequency', 'MONTHLY'),
        description:
          'Deduction frequency for a new loan when neither the request nor its product names one: MONTHLY, WEEKLY or QUARTERLY.',
      },
      {
        // Reader: AdvanceLoansService.resolveTerms(), when gracePeriods > 0.
        key: 'loan_grace_mode',
        value: v('loan_grace_mode', 'MORATORIUM_FULL'),
        description:
          'What a grace period defers: MORATORIUM_FULL (nothing is collected and interest capitalises), INTEREST_ONLY (interest is collected, principal waits) or NONE.',
      },
      {
        // Reader: LoanEligibilityService, via validateAffordability().
        key: 'loan_min_emi_amount',
        value: v('loan_min_emi_amount', '0'),
        description:
          'Smallest instalment a loan may be spread into. A request whose EMI falls below this is refused rather than accepted as a decades-long trickle.',
      },
      {
        // Reader: AdvanceLoansService.mintReference().
        key: 'loan_reference_prefix',
        value: v('loan_reference_prefix', 'LN'),
        description:
          'Prefix of the human reference minted for every loan (LN-202608-0001). Changing it does not renumber loans already filed.',
      },
      {
        // Reader: AdvanceLoansService.resolveEffectiveDate().
        key: 'advance_loan_allow_backdated_days',
        value: v('advance_loan_allow_backdated_days', '30'),
        description:
          'How far back a loan may be dated when it is filed. 0 forbids backdating entirely; the joining date is always the hard floor.',
      },
      {
        // Reader: LoanOverdueService.sweep().
        key: 'loan_overdue_after_cycles',
        value: v('loan_overdue_after_cycles', '2'),
        description:
          'Missed instalments before a loan is marked OVERDUE and the borrower is told.',
      },
      {
        // Reader: LoanLifecycleService.assertRestructureAuthorised().
        key: 'loan_restructure_requires_approval',
        value: v('loan_restructure_requires_approval', 'false'),
        description:
          'Require a second approver for any restructure of a live loan — a skipped instalment, a rate change, a top-up. On, the person performing it may not also be the one authorising it.',
      },
      {
        // Reader: LoanLifecycleService.prepay().
        key: 'loan_employee_self_prepay',
        value: v('loan_employee_self_prepay', 'false'),
        description:
          'Let an employee record a payment against their own loan. Off, only finance may — the money still has to be reconciled by someone.',
      },
      {
        // Reader: LoanLifecycleService.payoffQuote().
        key: 'loan_flat_prepayment_interest',
        value: v('loan_flat_prepayment_interest', 'PRORATA'),
        description:
          'Interest owed when a FLAT loan is settled early: PRORATA rebates the unearned portion, FULL charges the whole contracted interest anyway.',
      },
      {
        // Reader: AdvanceLoansService.resolveTerms(), for products whose
        // `requiresSecurity` is set.
        key: 'loan_security_deposit_percent',
        value: v('loan_security_deposit_percent', '0'),
        description:
          'Security deposit taken on a loan product that requires one, as a percentage of the principal. A product that requires security while this is 0 refuses the filing rather than recording a deposit of nothing.',
      },
      {
        // Reader: LoanLifecycleService.topup().
        key: 'loan_topup_enabled',
        value: v('loan_topup_enabled', 'false'),
        description:
          'Allow a running loan to be replaced by a larger one that settles it, so a borrower who needs more does not carry two instalments out of one salary.',
      },
      {
        key: 'loan_zero_salary_policy',
        value: v('loan_zero_salary_policy', 'DEFER'),
        description: 'What happens in a zero-pay cycle: DEFER or SKIP',
      },
      {
        key: 'loan_unpaid_leave_policy',
        value: v('loan_unpaid_leave_policy', 'PAUSE'),
        description:
          'Default behaviour during unpaid leave: CONTINUE, PAUSE or EXTEND. A LEAVE_TYPE library row can override this per leave type; the strictest wins.',
      },
      {
        key: 'loan_unpaid_leave_min_days',
        value: v('loan_unpaid_leave_min_days', '1'),
        description:
          'Unpaid leave days in a cycle before the leave policy applies, so a single day does not pause an instalment',
      },
      {
        key: 'loan_recovery_priority_order',
        value: v('loan_recovery_priority_order', 'ADVANCE,LOAN'),
        description:
          'Recovery order when several debts compete for a limited net pay. Advances first by default: that cash is already out the door.',
      },
      {
        key: 'loan_recover_on_run_types',
        value: v('loan_recover_on_run_types', 'REGULAR,FINAL_SETTLEMENT'),
        description:
          'Payroll run types that recover instalments. Excluding BONUS and ADJUSTMENT is what stops a retro or arrears run charging an EMI twice.',
      },
      {
        key: 'loan_recovery_failure_policy',
        value: v('loan_recovery_failure_policy', 'FAIL'),
        description:
          'If recovery planning fails: FAIL refuses to generate a payroll that would under-deduct; WARN generates it and logs.',
      },
      {
        key: 'loan_rounding_tolerance',
        value: v('loan_rounding_tolerance', '1.00'),
        description:
          'Residual that may be written off on a manual close — the small leftover after a final instalment',
      },
      {
        key: 'loan_prepayment_mode',
        value: v('loan_prepayment_mode', 'REDUCE_TENURE'),
        description:
          'After a prepayment: REDUCE_TENURE keeps the instalment and shortens the loan; REDUCE_EMI keeps the count and lowers each instalment.',
      },
      {
        key: 'loan_max_active_per_employee',
        value: v('loan_max_active_per_employee', '2'),
        description: 'Maximum concurrent advances/loans per employee',
      },
      {
        key: 'loan_min_service_months',
        value: v('loan_min_service_months', '0'),
        description:
          'Minimum completed months of service before an employee may borrow',
      },
      {
        key: 'loan_max_emi_percent_of_net',
        value: v('loan_max_emi_percent_of_net', '50'),
        description:
          'Eligibility ceiling: combined instalments may not exceed this share of monthly pay',
      },
      {
        key: 'loan_max_amount_multiple_of_salary',
        value: v('loan_max_amount_multiple_of_salary', '0'),
        description:
          'Maximum loan as a multiple of monthly pay. 0 = no ceiling.',
      },
      {
        key: 'loan_clearance_blocking_enabled',
        value: v('loan_clearance_blocking_enabled', 'true'),
        description:
          'Block offboarding clearance while an employee still owes a balance. ADMIN/HR can override with a reason, which is audited.',
      },
      {
        key: 'advance_loan_writeoff_roles',
        value: v('advance_loan_writeoff_roles', 'ADMIN'),
        description:
          'Roles permitted to write off loan balances (forgiving company money)',
      },
      {
        key: 'loan_waiver_roles',
        value: v('loan_waiver_roles', 'ADMIN,HR_MANAGER'),
        description: 'Roles permitted to waive loan interest or principal',
      },
      {
        key: 'advance_loan_finance_roles',
        value: v('advance_loan_finance_roles', 'ADMIN'),
        description:
          'Extra roles treated as finance for loan visibility, without adding a new system role',
      },
      {
        key: 'advance_loan_auditor_roles',
        value: v('advance_loan_auditor_roles', ''),
        description:
          'Roles granted READ-ONLY access to every loan. Blank disables auditor access.',
      },
      {
        // Unreadable until now. Fallback: LoanAccessService.auditorUserIds().
        key: 'advance_loan_auditor_user_ids',
        value: v('advance_loan_auditor_user_ids', ''),
        description:
          'Comma-separated user IDs granted READ-ONLY access to every loan — for a named auditor who should not be given a whole role. Blank disables it.',
      },
    ];
  }

  /**
   * The mail transport configuration actually in effect.
   *
   * Stored rows win; an ABSENT or EMPTY row falls through to the environment
   * and then to the built-in default (see `mail-settings.ts`). Both the SMTP
   * form (`getSettingsList()`) and the transporter (`MailService`) read this,
   * so the screen cannot disagree with what mail is sent through.
   *
   * One query, not one per key: `ensureTransporter()` runs on every send.
   */
  async getMailConfig(): Promise<MailConfig> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: [...MAIL_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    return resolveMailConfig(new Map(rows.map((r) => [r.key, r.value])));
  }

  /**
   * Get a single setting by key
   */
  async getSetting(key: string, defaultValue: string = ''): Promise<string> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key },
    });
    return setting ? setting.value : defaultValue;
  }

  /**
   * Company-wide lunch break policy used for automatic work-hour deduction.
   * `startMinutes` is minutes-from-midnight in company-local time;
   * `durationMinutes` is the deduction length (0 = never deduct).
   */
  async getLunchBreakPolicy(): Promise<{
    startMinutes: number;
    durationMinutes: number;
  }> {
    const startStr = await this.getSetting('lunch_break_start', '13:00');
    const durationStr = await this.getSetting(
      'lunch_break_duration_minutes',
      '60',
    );

    let startMinutes = 13 * 60;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(startStr)) {
      const [h, m] = startStr.split(':').map(Number);
      startMinutes = h * 60 + m;
    }

    const duration = parseInt(durationStr, 10);
    const durationMinutes = isNaN(duration) ? 60 : Math.max(0, duration);

    return { startMinutes, durationMinutes };
  }

  /**
   * Company-wide bounds on an employment start date. Backdating is unrestricted
   * out of the box (a blank `max_past_days` means no limit) so that late
   * paperwork and data migrations can be onboarded; HR can tighten it here
   * instead of in code.
   */
  async getEmploymentStartDatePolicy(): Promise<StartDatePolicy> {
    const [pastStr, futureStr, floorStr] = await Promise.all([
      this.getSetting('employee_start_date_max_past_days', ''),
      this.getSetting('employee_start_date_max_future_days', ''),
      this.getSetting('employee_start_date_floor', ''),
    ]);

    // Blank means unlimited; 0 is treated the same way so that clearing the
    // field from the admin panel can never lock onboarding out.
    let maxPastDays: number | null = DEFAULT_START_DATE_POLICY.maxPastDays;
    if (pastStr.trim()) {
      const past = parseInt(pastStr, 10);
      maxPastDays = isNaN(past) || past <= 0 ? null : past;
    }

    let maxFutureDays = DEFAULT_START_DATE_POLICY.maxFutureDays;
    if (futureStr.trim()) {
      const future = parseInt(futureStr, 10);
      if (!isNaN(future)) maxFutureDays = Math.max(0, future);
    }

    const floor = parseDateOnlyUTC(floorStr) ?? DEFAULT_START_DATE_POLICY.floor;

    return {
      maxPastDays,
      maxFutureDays,
      floor,
      minAgeYears: DEFAULT_START_DATE_POLICY.minAgeYears,
    };
  }

  /**
   * Company-wide geofencing policy used to gate employee self check-in.
   */
  async getGeofencingPolicy(branchId?: string): Promise<{
    enabled: boolean;
    officeLat: number | null;
    officeLng: number | null;
    radiusMeters: number;
  }> {
    // Per-branch override chain: branch column -> global SystemSetting -> default.
    const branch = branchId
      ? await this.prisma.branch.findUnique({
          where: { id: branchId },
          select: {
            geofencingEnabled: true,
            latitude: true,
            longitude: true,
            geofenceRadiusM: true,
          },
        })
      : null;

    const enabled =
      branch?.geofencingEnabled != null
        ? branch.geofencingEnabled
        : (await this.getSetting('geofencing_enabled', 'false')) === 'true';

    let officeLat: number | null;
    let officeLng: number | null;
    if (branch?.latitude != null && branch?.longitude != null) {
      officeLat = Number(branch.latitude);
      officeLng = Number(branch.longitude);
    } else {
      const latStr = await this.getSetting('office_latitude', '');
      const lngStr = await this.getSetting('office_longitude', '');
      officeLat =
        latStr !== '' && !isNaN(parseFloat(latStr)) ? parseFloat(latStr) : null;
      officeLng =
        lngStr !== '' && !isNaN(parseFloat(lngStr)) ? parseFloat(lngStr) : null;
    }

    let radiusMeters: number;
    if (branch?.geofenceRadiusM != null && branch.geofenceRadiusM > 0) {
      radiusMeters = branch.geofenceRadiusM;
    } else {
      const radiusStr = await this.getSetting(
        'geofencing_radius_meters',
        '100',
      );
      const radius = parseInt(radiusStr, 10);
      radiusMeters = isNaN(radius) || radius <= 0 ? 100 : radius;
    }

    return { enabled, officeLat, officeLng, radiusMeters };
  }

  /**
   * Per-branch office hours with global fallback (branch column -> global -> default).
   */
  async getOfficeHours(
    branchId?: string,
  ): Promise<{ start: string; end: string }> {
    const branch = branchId
      ? await this.prisma.branch.findUnique({
          where: { id: branchId },
          select: { officeStartTime: true, officeEndTime: true },
        })
      : null;
    return {
      start:
        branch?.officeStartTime ??
        (await this.getSetting('office_start_time', '08:30')),
      end:
        branch?.officeEndTime ??
        (await this.getSetting('office_end_time', '17:30')),
    };
  }

  async setSetting(key: string, value: string) {
    // Secrets are never writable through the generic settings endpoint.
    //
    // Without this, POST /system-settings {"copilot.llmApiKeyEnc": "anything"}
    // overwrites the AES ciphertext with attacker-chosen plaintext; decryptSecret
    // then throws on every read and the integration is bricked until somebody
    // reads the logs. Each secret has a dedicated, typed admin endpoint that
    // encrypts on write — use those.
    if (isProtectedSettingKey(key)) {
      throw new BadRequestException(
        `${key} holds a secret and cannot be set through the generic settings endpoint. ` +
          `Use the dedicated integration settings page.`,
      );
    }

    // Declared-shape validation, ahead of the per-key special cases below.
    // 'passthrough' for a key with no declared shape (the write path accepts
    // arbitrary keys on purpose); 'store' carries the NORMALISED value, so what
    // the settings screen reads back is the exact string the engine compares
    // against; 'clear' is a blank on a key that has a real engine default.
    const declared = validateSettingValue(key, value);

    if (declared.action === 'clear') {
      // Delete the override rather than storing ''. Every reader resolves this
      // key as `getSetting(key, default)`, and `getSettingsList()` as
      // `v(key, fallback)` — both of which read an ABSENT row as the default
      // and an empty row as an empty string. Storing '' would show the field
      // blank while the engine used the default: the same "screen and engine
      // disagree" failure §12 exists to remove.
      //
      // deleteMany, not delete: clearing a key that was never overridden is a
      // no-op, not a 404.
      await this.prisma.systemSetting.deleteMany({ where: { key } });
      // Unreachable while `system_timezone` has no declared shape, but the
      // cached zone must not survive a clear if it ever gains one — the write
      // below invalidates for exactly the same reason.
      if (key === 'system_timezone') {
        companyTzCache.invalidate();
      }
      return { key, value: null };
    }

    let cleanValue = declared.action === 'store' ? declared.value : value;
    if (
      [
        'dept_manager_min_tenure_months',
        'dept_manager_transition_days',
        'lunch_break_duration_minutes',
        // Blank is meaningful on the start-date keys (= unlimited backdating),
        // and the isNaN guard below lets it through untouched.
        'employee_start_date_max_past_days',
        'employee_start_date_max_future_days',
      ].includes(key)
    ) {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        cleanValue = Math.max(0, num).toString();
      }
    }
    if (
      [
        'attendance_day_end_time',
        'attendance_daily_report_time',
        'office_start_time',
        'office_end_time',
        'lunch_break_start',
      ].includes(key) &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ) {
      throw new BadRequestException(
        `Invalid time for ${key}: expected HH:MM (24-hour), got "${value}"`,
      );
    }
    if (key === 'dashboard_layout' && !['v1', 'v2'].includes(value)) {
      throw new BadRequestException(
        `Invalid dashboard_layout: expected "v1" or "v2", got "${value}"`,
      );
    }
    if (key === 'system_timezone' && !DateTime.now().setZone(value).isValid) {
      throw new BadRequestException(
        `Invalid system_timezone: "${value}" is not a valid IANA timezone (e.g. Asia/Singapore)`,
      );
    }
    if (key === 'geofencing_radius_meters') {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        throw new BadRequestException(
          `Invalid radius for ${key}: must be a positive number of meters`,
        );
      }
      cleanValue = num.toString();
    }
    if (key === 'office_latitude' && value !== '') {
      const num = parseFloat(value);
      if (isNaN(num) || num < -90 || num > 90) {
        throw new BadRequestException(
          `Invalid latitude for ${key}: must be between -90 and 90`,
        );
      }
    }
    if (key === 'office_longitude' && value !== '') {
      const num = parseFloat(value);
      if (isNaN(num) || num < -180 || num > 180) {
        throw new BadRequestException(
          `Invalid longitude for ${key}: must be between -180 and 180`,
        );
      }
    }
    const result = await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: cleanValue, updatedAt: new Date() },
      create: { key, value: cleanValue },
    });
    // Company timezone drives every business-rule boundary; drop the cached
    // value so the new zone applies on the very next request, not 60 s later.
    if (key === 'system_timezone') {
      companyTzCache.invalidate();
    }
    return result;
  }

  /**
   * Update multiple settings at once
   */
  async updateSettings(settings: Record<string, string>) {
    // Shape-check the WHOLE payload before writing any of it. `setSetting()`
    // validates too, but it is called through Promise.all below — so a bad
    // fourth key would land after the first three had already been persisted,
    // and the admin would get an error describing a save that half happened.
    // Same reasoning as the developer-key gate in the controller: refuse the
    // request, do not half-apply it.
    const rejections: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      try {
        validateSettingValue(key, String(value));
      } catch (err) {
        rejections.push(
          err instanceof BadRequestException ? err.message : String(err),
        );
      }
    }
    if (rejections.length > 0) {
      throw new BadRequestException(rejections.join('; '));
    }

    await this.resolveFavicon(settings);

    if (settings.geofencing_enabled === 'true') {
      const lat =
        settings.office_latitude ??
        (await this.getSetting('office_latitude', ''));
      const lng =
        settings.office_longitude ??
        (await this.getSetting('office_longitude', ''));
      if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
        throw new BadRequestException(
          'Office latitude and longitude must be set before enabling geofencing.',
        );
      }
    }

    const promises = Object.entries(settings).map(([key, value]) =>
      this.setSetting(key, String(value)),
    );
    await Promise.all(promises);
    return { success: true, message: 'Settings updated successfully' };
  }

  /**
   * Mutates `settings` so `company_favicon_url` stays in sync with the logo.
   *
   * - SVG takes precedence over image URL (matches the UI rule).
   * - Only regenerates when the logo actually changed or no favicon exists yet,
   *   so unrelated saves never re-rasterize or touch storage.
   * - A caller-supplied favicon (e.g. from the logo-upload endpoint) is kept.
   * - Clearing both logo fields clears the favicon.
   *
   * Favicon generation is best-effort: any failure leaves the existing favicon
   * untouched and the save proceeds. Only the favicon key is touched here.
   */
  private async resolveFavicon(
    settings: Record<string, string>,
  ): Promise<void> {
    // Caller already provided a favicon — trust it, don't regenerate.
    if (settings.company_favicon_url && settings.company_favicon_url.trim()) {
      return;
    }

    const svg = settings.company_logo_svg;
    const url = settings.company_logo_url;

    // Neither logo field is part of this update — leave favicon as-is.
    if (svg === undefined && url === undefined) return;

    const currentFavicon = await this.getSetting('company_favicon_url', '');

    try {
      if (svg && svg.trim()) {
        const currentSvg = await this.getSetting('company_logo_svg', '');
        if (svg !== currentSvg || !currentFavicon) {
          const favicon = await this.uploadService.generateFaviconFromSvg(svg);
          if (favicon) settings.company_favicon_url = favicon;
        }
      } else if (url && url.trim()) {
        const currentUrl = await this.getSetting('company_logo_url', '');
        if (url !== currentUrl || !currentFavicon) {
          const favicon = await this.uploadService.generateFaviconFromUrl(url);
          if (favicon) settings.company_favicon_url = favicon;
        }
      } else {
        // Both logo fields explicitly cleared → drop the favicon.
        settings.company_favicon_url = '';
      }
    } catch (err) {
      this.logger.warn(`Favicon resolution failed: ${err.message}`);
    }
  }

  /**
   * Build and return a typed PayrollConfig object consumed by PayrollsService.
   * Any setting not in the DB falls back to the Indian IT payroll default.
   */
  async getPayrollConfig(): Promise<PayrollConfig> {
    const list = await this.getSettingsList();
    const map = new Map(list.map((s) => [s.key, s.value]));
    const v = (key: string, fallback = '') => map.get(key) ?? fallback;

    // Parse tax brackets
    let taxBrackets: TaxBracket[] = [];
    try {
      taxBrackets = JSON.parse(v('payroll_tax_brackets', '[]'));
    } catch {
      taxBrackets = [
        { limit: 300000, rate: 0.0 },
        { limit: 700000, rate: 0.05 },
        { limit: 1000000, rate: 0.1 },
        { limit: 1200000, rate: 0.15 },
        { limit: 1500000, rate: 0.2 },
        { limit: 999999999, rate: 0.3 },
      ];
    }

    // Parse professional tax slabs
    let ptSlabs: ProfessionalTaxSlab[] = [];
    try {
      ptSlabs = JSON.parse(v('payroll_professional_tax_slabs', '[]'));
    } catch {
      ptSlabs = [
        { upTo: 10000, tax: 0 },
        { upTo: 15000, tax: 110 },
        { upTo: 20000, tax: 130 },
        { upTo: 25000, tax: 150 },
        { upTo: 999999999, tax: 200 },
      ];
    }

    return {
      country: v('payroll_country', 'IN'),
      currency: v('payroll_currency', 'INR'),
      currencySymbol: v('payroll_currency_symbol', '₹'),
      workHoursPerDay: parseFloat(v('payroll_work_hours_per_day', '8')),
      workDaysPerWeek: parseInt(v('payroll_work_days_per_week', '5'), 10),
      overtimeRate: parseFloat(v('payroll_overtime_rate', '1.5')),

      pfEnabled: v('payroll_pf_enabled', 'true') !== 'false',
      pfEmployeeRate: parseFloat(v('payroll_pf_employee_rate', '0.12')),
      pfEmployerRate: parseFloat(v('payroll_pf_employer_rate', '0.12')),
      pfSalaryCap: parseFloat(v('payroll_pf_salary_cap', '15000')),
      pfOnFullSalary: v('payroll_pf_on_full_salary', 'false') === 'true',

      professionalTaxEnabled:
        v('payroll_professional_tax_enabled', 'true') !== 'false',
      professionalTaxSlabs: ptSlabs,

      taxRegime: v('payroll_tax_regime', 'new'),
      standardDeduction: parseFloat(v('payroll_standard_deduction', '75000')),
      personalDeductionMonthly: parseFloat(
        v('payroll_personal_deduction_monthly', '6250'),
      ),
      taxBrackets,
      taxCalculationPeriod: v('payroll_tax_calculation_period', 'annual') as
        | 'annual'
        | 'monthly',

      esiEnabled: v('payroll_esi_enabled', 'true') !== 'false',
      esiEmployeeRate: parseFloat(v('payroll_esi_employee_rate', '0.0075')),
      esiEmployerRate: parseFloat(v('payroll_esi_employer_rate', '0.0325')),
      esiSalaryCap: parseFloat(v('payroll_esi_salary_cap', '21000')),

      basicSalaryPercentage: parseFloat(
        v('payroll_basic_salary_percentage', '40'),
      ),

      taxRebateEnabled: v('payroll_tax_rebate_enabled', 'true') !== 'false',
      taxRebateLimit: parseFloat(v('payroll_tax_rebate_limit', '700000')),

      cessEnabled: v('payroll_cess_enabled', 'true') !== 'false',
      cessRate: parseFloat(v('payroll_cess_rate', '0.04')),

      gratuityEnabled: v('payroll_gratuity_enabled', 'false') === 'true',
      gratuityRate: parseFloat(v('payroll_gratuity_rate', '0.0481')),

      // Defaults to true so daily-wage staff are treated exactly like monthly
      // staff until an admin deliberately exempts them.
      dailyWageStatutoryDeductions:
        v('payroll_daily_wage_statutory_deductions', 'true') !== 'false',
      // Default false, hence `=== 'true'` rather than the `!== 'false'` idiom
      // used for default-on keys above.
      dailyWagePayLeave: v('payroll_daily_wage_pay_leave', 'false') === 'true',
      dailyWagePayHolidays:
        v('payroll_daily_wage_pay_holidays', 'false') === 'true',
    };
  }

  /**
   * Build and return a typed OvertimeConfig object.
   */
  async getOvertimeConfig(): Promise<OvertimeConfig> {
    const list = await this.getSettingsList();
    const map = new Map(list.map((s) => [s.key, s.value]));
    const v = (key: string, fallback = '') => map.get(key) ?? fallback;

    return {
      enabled: v('overtime_enabled', 'true') !== 'false',
      lateThreshold: v('overtime_late_threshold', '22:00'),
      foodAllowanceEnabled:
        v('overtime_food_allowance_enabled', 'true') !== 'false',
      foodAllowanceThreshold: v(
        'overtime_food_allowance_threshold',
        v('overtime_late_threshold', '22:00'),
      ),
      foodAllowanceAmount: parseFloat(
        v('overtime_food_allowance_amount', '150'),
      ),
      regularRate: parseFloat(v('overtime_regular_rate', '1.5')),
      lateRate: parseFloat(v('overtime_late_rate', '1.5')),
      doubleOtEnabled: v('overtime_double_ot_enabled', 'true') !== 'false',
      doubleRate: parseFloat(v('overtime_double_rate', '2.0')),
      sunday: {
        regularRate: parseFloat(
          v('overtime_sunday_regular_rate', v('overtime_double_rate', '2.0')),
        ),
        lateRate: parseFloat(
          v('overtime_sunday_late_rate', v('overtime_double_rate', '2.0')),
        ),
        lateThreshold: v(
          'overtime_sunday_late_threshold',
          v('overtime_late_threshold', '22:00'),
        ),
      },
      holiday: {
        regularRate: parseFloat(
          v('overtime_holiday_regular_rate', v('overtime_double_rate', '2.0')),
        ),
        lateRate: parseFloat(
          v('overtime_holiday_late_rate', v('overtime_double_rate', '2.0')),
        ),
        lateThreshold: v(
          'overtime_holiday_late_threshold',
          v('overtime_late_threshold', '22:00'),
        ),
      },
      shiftEndTime: v('overtime_shift_end_time', '17:00'),
      doubleFoodAllowanceAnyTime:
        v('overtime_double_food_allowance_any_time', 'false') !== 'false',
      doubleOtAllowAnytime:
        v('overtime_double_ot_allow_anytime', 'true') !== 'false',
      maxHoursPerDay: parseFloat(v('overtime_max_hours_per_day', '4')),
      maxHoursPerDoubleDay: parseFloat(
        v('overtime_max_hours_per_double_day', '12'),
      ),
      maxHoursPerMonth: parseFloat(v('overtime_max_hours_per_month', '30')),
      maxHoursPerYear: parseFloat(v('overtime_max_hours_per_year', '200')),
      requireManagerApproval:
        v('overtime_require_manager_approval', 'true') !== 'false',
      allowEmployeeSubmit:
        v('overtime_allow_employee_submit', 'true') !== 'false',
    };
  }

  /**
   * Apply the standard Indian payroll preset.
   */
  async applyIndiaPreset(): Promise<{ success: boolean; message: string }> {
    return this.applyCountryPreset('IN');
  }

  /**
   * Universal multi-country preset dispatcher.
   * Supports: IN (India), US (USA), GB (UK), AE (UAE), SG (Singapore),
   *           DE (Germany), CUSTOM (blank slate).
   */
  async applyCountryPreset(
    country: string,
  ): Promise<{ success: boolean; message: string }> {
    const presets = COUNTRY_PRESETS;

    const data = presets[country.toUpperCase()];
    if (!data) {
      return {
        success: false,
        message: `Unknown preset: ${country}. Supported: IN, US, GB, AE, OM, SG, DE, CUSTOM`,
      };
    }

    // Keep the work calendar in sync with the preset's working-days-per-week so
    // the payroll engine (which derives month working-days from
    // `calendar_weekly_holidays`) actually honours it — otherwise the preset's
    // 5- vs 6-day week is silently ignored. Map days/week → weekly off-days:
    //   7 → none, 6 → Sunday (0), 5 → Sun + Sat (0,6), else lower → trim from Sat.
    const daysPerWeek = parseInt(data.payroll_work_days_per_week ?? '5', 10);
    if (!Number.isNaN(daysPerWeek) && daysPerWeek >= 1 && daysPerWeek <= 7) {
      const OFF_DAY_PRIORITY = [0, 6, 5, 4, 3, 2, 1]; // Sun, Sat, Fri, …
      const offCount = 7 - daysPerWeek;
      data.calendar_weekly_holidays = OFF_DAY_PRIORITY.slice(0, offCount)
        .sort((a, b) => a - b)
        .join(',');
    }

    await this.updateSettings(data);
    return {
      success: true,
      message: `${country.toUpperCase()} payroll preset applied successfully`,
    };
  }
}

// ── Exported Types ─────────────────────────────────────────────────────────────

export interface TaxBracket {
  limit: number;
  rate: number;
}

export interface ProfessionalTaxSlab {
  upTo: number;
  tax: number;
}

export interface PayrollConfig {
  country: string;
  currency: string;
  currencySymbol: string;
  workHoursPerDay: number;
  workDaysPerWeek: number;
  overtimeRate: number;

  pfEnabled: boolean;
  pfEmployeeRate: number;
  pfEmployerRate: number;
  pfSalaryCap: number;
  pfOnFullSalary: boolean;

  professionalTaxEnabled: boolean;
  professionalTaxSlabs: ProfessionalTaxSlab[];

  taxRegime: string;
  standardDeduction: number;
  personalDeductionMonthly: number;
  taxBrackets: TaxBracket[];
  taxCalculationPeriod: 'annual' | 'monthly';

  // Section 87A Rebate
  taxRebateEnabled: boolean;
  taxRebateLimit: number;

  // Health & Education Cess
  cessEnabled: boolean;
  cessRate: number;

  esiEnabled: boolean;
  esiEmployeeRate: number;
  esiEmployerRate: number;
  esiSalaryCap: number;

  basicSalaryPercentage: number;

  gratuityEnabled: boolean;
  gratuityRate: number;

  /**
   * Whether daily-wage (salaryType = DAILY) employees are put through the same
   * statutory pipeline (PF / ESI / professional tax / income tax) as monthly
   * staff. false → their gross is paid out with only discipline deductions and
   * advance/loan recovery applied. Monthly employees are never affected.
   */
  dailyWageStatutoryDeductions: boolean;

  /**
   * Pay daily-wage employees their day rate for approved PAID leave days.
   * Default false — the baseline rule is that only days actually worked are
   * paid. Has no effect on monthly staff, whose paid leave is already inside
   * their monthly salary.
   */
  dailyWagePayLeave: boolean;

  /**
   * Pay daily-wage employees their day rate for public holidays in the period.
   * Excludes holidays that fall on a weekly-off day and days the employee
   * actually worked (already paid as present days). Default false.
   */
  dailyWagePayHolidays: boolean;
}

export interface OvertimeConfig {
  enabled: boolean;
  lateThreshold: string;
  foodAllowanceEnabled: boolean;
  foodAllowanceThreshold: string;
  foodAllowanceAmount: number;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  sunday: { regularRate: number; lateRate: number; lateThreshold: string };
  holiday: { regularRate: number; lateRate: number; lateThreshold: string };
  shiftEndTime: string;
  doubleFoodAllowanceAnyTime: boolean;
  doubleOtAllowAnytime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
  requireManagerApproval: boolean;
  allowEmployeeSubmit: boolean;
}
